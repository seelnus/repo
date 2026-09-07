import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { stringify } from 'csv-stringify/sync';
import { PrismaService } from './prisma.service';

type MembershipInput = {
  departmentId: number;
  isPrimary?: boolean;
  defaultEvalEnabled?: boolean;
  roleName?: string | null;
};

type ContactWriteInput = {
  name?: unknown;
  department?: unknown;
  jobNo?: unknown;
  position?: unknown;
  phone?: unknown;
  email?: unknown;
  tags?: unknown;
  isActive?: unknown;
  memberships?: MembershipInput[];
};

type DepartmentRow = {
  id: number;
  code: string;
  name: string;
  parentId: number | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type DepartmentView = DepartmentRow & {
  path: string;
  isLeaf: boolean;
  directMemberCount: number;
  totalMemberCount: number;
  children: DepartmentView[];
};

type NormalizedMembership = {
  departmentId: number;
  isPrimary: boolean;
  defaultEvalEnabled: boolean;
  roleName: string | null;
};

function stringOrNull(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeContactPhone(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[\s()（）-]/g, '');
}

export function splitDepartmentPath(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\/／>＞]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseContactDepartmentPaths(value: unknown): {
  paths: string[][];
  duplicatePath: string | null;
} {
  const paths = String(value ?? '')
    .split(/[;；]+/)
    .map((item) => splitDepartmentPath(item))
    .filter((parts) => parts.length > 0);
  const seen = new Set<string>();
  let duplicatePath: string | null = null;
  for (const parts of paths) {
    const path = parts.join('/');
    if (seen.has(path)) {
      duplicatePath = path;
      break;
    }
    seen.add(path);
  }
  return { paths, duplicatePath };
}

export function normalizeMembershipInputs(
  rows: MembershipInput[] | undefined,
): NormalizedMembership[] | undefined {
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BadRequestException('请至少设置一个主部门');
  }

  const normalized = rows.map((row) => {
    const departmentId = Number(row?.departmentId);
    if (!Number.isInteger(departmentId) || departmentId <= 0) {
      throw new BadRequestException('所属部门不合法');
    }
    const isPrimary = Boolean(row?.isPrimary);
    return {
      departmentId,
      isPrimary,
      defaultEvalEnabled: isPrimary ? true : Boolean(row?.defaultEvalEnabled),
      roleName: stringOrNull(row?.roleName),
    };
  });

  if (
    new Set(normalized.map((row) => row.departmentId)).size !==
    normalized.length
  ) {
    throw new BadRequestException('同一部门不能重复添加');
  }
  if (normalized.filter((row) => row.isPrimary).length !== 1) {
    throw new BadRequestException('每名员工必须且只能设置一个主部门');
  }
  return normalized;
}

@Injectable()
export class OrganizationService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.backfillLegacyDepartments();
  }

  async listDepartmentTree() {
    const [departments, memberships] = await Promise.all([
      this.prisma.orgDepartment.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.contactDepartmentMembership.groupBy({
        by: ['departmentId'],
        _count: { _all: true },
      }),
    ]);
    return this.buildDepartmentTree(
      departments,
      new Map(memberships.map((row) => [row.departmentId, row._count._all])),
    );
  }

  async createDepartment(data: any) {
    const name = String(data?.name ?? '').trim();
    if (!name) throw new BadRequestException('请输入部门名称');
    const parentId = this.optionalPositiveId(data?.parentId, '父部门');
    const sortOrder = this.integerOrDefault(data?.sortOrder, 0);
    const code = stringOrNull(data?.code) || this.newDepartmentCode();

    await this.assertDepartmentParent(parentId);
    await this.assertSiblingNameAvailable(parentId, name);

    try {
      return await this.prisma.orgDepartment.create({
        data: { code, name, parentId, sortOrder },
      });
    } catch (error) {
      this.handleDepartmentWriteError(error);
    }
  }

  async updateDepartment(id: number, data: any) {
    const department = await this.requireDepartment(id);
    const name =
      data?.name === undefined
        ? department.name
        : String(data.name ?? '').trim();
    if (!name) throw new BadRequestException('请输入部门名称');
    const sortOrder =
      data?.sortOrder === undefined
        ? department.sortOrder
        : this.integerOrDefault(data.sortOrder, 0);

    await this.assertSiblingNameAvailable(
      department.parentId,
      name,
      department.id,
    );
    try {
      const updated = await this.prisma.orgDepartment.update({
        where: { id },
        data: { name, sortOrder },
      });
      await this.syncLegacyDepartmentsForSubtree(id);
      return updated;
    } catch (error) {
      this.handleDepartmentWriteError(error);
    }
  }

  async moveDepartment(id: number, data: any) {
    const department = await this.requireDepartment(id);
    const parentId = this.optionalPositiveId(data?.parentId, '父部门');
    if (parentId === id) throw new BadRequestException('部门不能移动到自身');
    await this.assertDepartmentParent(parentId);

    if (parentId !== null) {
      const descendantIds = await this.collectDescendantIds(id);
      if (descendantIds.includes(parentId)) {
        throw new BadRequestException('部门不能移动到自身的下级部门');
      }
    }
    await this.assertSiblingNameAvailable(parentId, department.name, id);

    await this.prisma.orgDepartment.update({
      where: { id },
      data: { parentId },
    });
    await this.syncLegacyDepartmentsForSubtree(id);
    return this.requireDepartment(id);
  }

  async setDepartmentStatus(id: number, isActive: boolean) {
    const department = await this.requireDepartment(id);
    if (isActive && department.parentId) {
      const parent = await this.requireDepartment(department.parentId);
      if (!parent.isActive) {
        throw new BadRequestException('请先启用上级部门');
      }
    }
    const ids = isActive ? [id] : await this.collectSubtreeIds(id);
    await this.prisma.orgDepartment.updateMany({
      where: { id: { in: ids } },
      data: { isActive },
    });
    return { ok: true, affected: ids.length };
  }

  async deleteDepartment(id: number) {
    await this.requireDepartment(id);
    const [childCount, membershipCount, evalSnapshotCount] = await Promise.all([
      this.prisma.orgDepartment.count({ where: { parentId: id } }),
      this.prisma.contactDepartmentMembership.count({
        where: { departmentId: id },
      }),
      this.prisma.evalParticipantGroupSnapshot.count({
        where: { departmentId: id },
      }),
    ]);
    if (childCount || membershipCount || evalSnapshotCount) {
      throw new ConflictException(
        '该部门存在下级部门、人员归属或环评历史，只能停用，不能删除',
      );
    }
    await this.prisma.orgDepartment.delete({ where: { id } });
    return { ok: true };
  }

  async listContacts(query: {
    q?: string;
    departmentId?: number;
    membershipType?: 'primary' | 'secondary' | 'all';
    status?: 'active' | 'inactive' | 'all';
  }) {
    const departments = await this.prisma.orgDepartment.findMany();
    const pathMap = this.departmentPathMap(departments);
    const departmentIds = query.departmentId
      ? await this.collectSubtreeIds(query.departmentId)
      : undefined;
    const keyword = String(query.q ?? '').trim();
    const membershipType = query.membershipType || 'all';
    const status = query.status || 'active';

    const contacts = await this.prisma.contact.findMany({
      where: {
        ...(status === 'all' ? {} : { isActive: status === 'active' }),
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword } },
                { phone: { contains: keyword } },
                { jobNo: { contains: keyword } },
                { position: { contains: keyword } },
                { department: { contains: keyword } },
                {
                  memberships: {
                    some: { department: { name: { contains: keyword } } },
                  },
                },
              ],
            }
          : {}),
        ...(departmentIds
          ? {
              memberships: {
                some: {
                  departmentId: { in: departmentIds },
                  ...(membershipType === 'primary'
                    ? { isPrimary: true }
                    : membershipType === 'secondary'
                      ? { isPrimary: false }
                      : {}),
                },
              },
            }
          : {}),
      },
      include: {
        memberships: {
          include: { department: true },
          orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });

    const phones = contacts.map((contact) => contact.phone);
    const samePhoneContacts = phones.length
      ? await this.prisma.contact.findMany({
          where: { phone: { in: phones } },
          select: { phone: true },
        })
      : [];
    const phoneCounts = new Map<string, number>();
    samePhoneContacts.forEach((row) =>
      phoneCounts.set(row.phone, (phoneCounts.get(row.phone) || 0) + 1),
    );
    const conflictPhones = new Set(
      Array.from(phoneCounts.entries())
        .filter(([, count]) => count > 1)
        .map(([phone]) => phone),
    );

    return contacts.map((contact) => ({
      ...contact,
      identityConflict: conflictPhones.has(contact.phone),
      primaryDepartmentPath:
        contact.memberships.find((row) => row.isPrimary)?.departmentId !==
        undefined
          ? pathMap.get(
              contact.memberships.find((row) => row.isPrimary)!.departmentId,
            ) || null
          : null,
      memberships: contact.memberships.map((membership) => ({
        ...membership,
        departmentPath:
          pathMap.get(membership.departmentId) || membership.department.name,
        departmentActive: membership.department.isActive,
      })),
    }));
  }

  async createContact(data: ContactWriteInput) {
    return this.writeContact(null, data);
  }

  async updateContact(id: number, data: ContactWriteInput) {
    await this.requireContact(id);
    return this.writeContact(id, data);
  }

  async setContactStatus(id: number, isActive: boolean) {
    await this.requireContact(id);
    await this.prisma.contact.update({
      where: { id },
      data: { isActive },
    });
    return { ok: true };
  }

  async deleteContact(id: number) {
    await this.requireContact(id);
    const [whitelists, responses, relations, participants, results] =
      await Promise.all([
        this.prisma.whitelistMember.count({ where: { contactId: id } }),
        this.prisma.surveyResponse.count({ where: { rateeContactId: id } }),
        this.prisma.evalRelation.count({
          where: {
            OR: [{ raterContactId: id }, { rateeContactId: id }],
          },
        }),
        this.prisma.evalCycleParticipant.count({ where: { contactId: id } }),
        this.prisma.evalEmployeeResult.count({ where: { rateeContactId: id } }),
      ]);
    if (whitelists || responses || relations || participants || results) {
      throw new ConflictException(
        '该联系人已有白名单、答卷或环评数据，请停用，不要删除',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.contactDepartmentMembership.deleteMany({
        where: { contactId: id },
      });
      await tx.contact.delete({ where: { id } });
    });
    return { ok: true };
  }

  async importContacts(rows: any[], dryRun = false) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('导入文件没有有效数据');
    }
    const existing = await this.prisma.contact.findMany({
      include: { memberships: true },
    });
    const byPhone = new Map<string, typeof existing>();
    for (const contact of existing) {
      const list = byPhone.get(contact.phone) || [];
      list.push(contact);
      byPhone.set(contact.phone, list);
    }

    const preview: Array<{
      row: number;
      action: 'create' | 'update' | 'conflict' | 'skip';
      name: string;
      phone: string;
      department: string | null;
      primaryDepartment: string | null;
      secondaryDepartments: string[];
      reason?: string;
    }> = [];
    const normalizedRows: Array<{
      row: number;
      data: ReturnType<OrganizationService['basicContactData']>;
      departmentPaths: string[][];
      contactId?: number;
    }> = [];
    const incomingPhones = new Set<string>();

    rows.forEach((row, index) => {
      const parsedDepartments = parseContactDepartmentPaths(
        row.department || row['部门'],
      );
      const departmentNames = parsedDepartments.paths.map((parts) =>
        parts.join('/'),
      );
      const data = this.basicContactData({
        name: row.name || row['姓名'],
        department: departmentNames[0],
        jobNo: row.jobNo || row.job_no || row['工号'],
        position: row.position || row['职位'],
        phone: row.phone || row['手机号'],
        email: row.email || row['邮箱'],
        tags: row.tags || row['标签'],
        isActive:
          row.isActive === undefined
            ? row['状态'] !== '停用'
            : Boolean(row.isActive),
      });
      const rowNumber = index + 2;
      if (!data.name || !data.phone) {
        preview.push({
          row: rowNumber,
          action: 'skip',
          name: data.name,
          phone: data.phone,
          department: data.department,
          primaryDepartment: data.department,
          secondaryDepartments: departmentNames.slice(1),
          reason: '缺少姓名或手机号',
        });
        return;
      }
      if (parsedDepartments.duplicatePath) {
        preview.push({
          row: rowNumber,
          action: 'skip',
          name: data.name,
          phone: data.phone,
          department: data.department,
          primaryDepartment: data.department,
          secondaryDepartments: departmentNames.slice(1),
          reason: `同一行重复声明部门：${parsedDepartments.duplicatePath}`,
        });
        return;
      }
      if (incomingPhones.has(data.phone)) {
        preview.push({
          row: rowNumber,
          action: 'conflict',
          name: data.name,
          phone: data.phone,
          department: data.department,
          primaryDepartment: data.department,
          secondaryDepartments: departmentNames.slice(1),
          reason: '导入文件内手机号重复',
        });
        return;
      }
      incomingPhones.add(data.phone);
      const matches = byPhone.get(data.phone) || [];
      if (matches.length > 1) {
        preview.push({
          row: rowNumber,
          action: 'conflict',
          name: data.name,
          phone: data.phone,
          department: data.department,
          primaryDepartment: data.department,
          secondaryDepartments: departmentNames.slice(1),
          reason: '系统中存在多名联系人共用该手机号，请先手工处理',
        });
        return;
      }
      const action = matches.length === 1 ? 'update' : 'create';
      preview.push({
        row: rowNumber,
        action,
        name: data.name,
        phone: data.phone,
        department: data.department,
        primaryDepartment: data.department,
        secondaryDepartments: departmentNames.slice(1),
      });
      normalizedRows.push({
        row: rowNumber,
        data,
        departmentPaths: parsedDepartments.paths,
        ...(matches[0] ? { contactId: matches[0].id } : {}),
      });
    });

    const summary = {
      total: rows.length,
      create: preview.filter((row) => row.action === 'create').length,
      update: preview.filter((row) => row.action === 'update').length,
      conflict: preview.filter((row) => row.action === 'conflict').length,
      skip: preview.filter((row) => row.action === 'skip').length,
    };
    if (dryRun) return { summary, rows: preview };
    if (summary.conflict || summary.skip) {
      throw new BadRequestException(
        `导入存在 ${summary.conflict} 条冲突和 ${summary.skip} 条无效数据，请先修正`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const row of normalizedRows) {
        const departments: DepartmentRow[] = [];
        for (const parts of row.departmentPaths) {
          departments.push(await this.ensureDepartmentPath(tx, parts));
        }
        const primaryDepartment = departments[0] || null;
        const primaryDepartmentPath = primaryDepartment
          ? await this.departmentPath(tx, primaryDepartment.id)
          : null;
        const contact = row.contactId
          ? await tx.contact.update({
              where: { id: row.contactId },
              data: {
                ...row.data,
                department: primaryDepartmentPath,
              },
            })
          : await tx.contact.create({
              data: {
                ...row.data,
                department: primaryDepartmentPath,
              },
            });
        await tx.contactDepartmentMembership.deleteMany({
          where: { contactId: contact.id },
        });
        if (departments.length) {
          await tx.contactDepartmentMembership.createMany({
            data: departments.map((department, index) => ({
              contactId: contact.id,
              departmentId: department.id,
              isPrimary: index === 0,
              defaultEvalEnabled: true,
            })),
          });
        }
      }
    });
    return { summary, rows: preview };
  }

  async exportContactsCsv() {
    const [contacts, departments] = await Promise.all([
      this.prisma.contact.findMany({
        include: {
          memberships: { orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.orgDepartment.findMany(),
    ]);
    const pathMap = this.departmentPathMap(departments);
    return stringify(
      contacts.map((item) => ({
        姓名: item.name,
        部门:
          item.memberships
            .map((membership) => pathMap.get(membership.departmentId))
            .filter(Boolean)
            .join(';') ||
          item.department ||
          '',
        工号: item.jobNo || '',
        职位: item.position || '',
        手机号: item.phone || '',
        邮箱: item.email || '',
        标签: item.tags || '',
        状态: item.isActive ? '启用' : '停用',
      })),
      { header: true, bom: true },
    );
  }

  private async writeContact(id: number | null, data: ContactWriteInput) {
    const basic = this.basicContactData(data, true);
    const memberships = normalizeMembershipInputs(data.memberships);
    await this.assertPhoneAvailable(basic.phone, id);

    if (memberships) await this.assertMembershipDepartments(memberships);
    const contact = await this.prisma.$transaction(async (tx) => {
      const primary = memberships?.find((row) => row.isPrimary);
      const department = primary
        ? await this.departmentPath(tx, primary.departmentId)
        : basic.department;
      const saved = id
        ? await tx.contact.update({
            where: { id },
            data: { ...basic, department },
          })
        : await tx.contact.create({
            data: { ...basic, department },
          });
      if (memberships) {
        await tx.contactDepartmentMembership.deleteMany({
          where: { contactId: saved.id },
        });
        await tx.contactDepartmentMembership.createMany({
          data: memberships.map((membership) => ({
            contactId: saved.id,
            ...membership,
          })),
        });
      }
      return saved;
    });
    return (await this.listContacts({ q: contact.phone, status: 'all' })).find(
      (row) => row.id === contact.id,
    );
  }

  private basicContactData(data: ContactWriteInput, required = false) {
    const name = String(data.name ?? '').trim();
    const phone = normalizeContactPhone(data.phone);
    if (required && !name) throw new BadRequestException('请输入姓名');
    if (required && !phone) throw new BadRequestException('请输入手机号');
    return {
      name,
      department: stringOrNull(data.department),
      jobNo: stringOrNull(data.jobNo),
      position: stringOrNull(data.position),
      phone,
      email: stringOrNull(data.email),
      tags: stringOrNull(data.tags),
      isActive: data.isActive === undefined ? true : Boolean(data.isActive),
    };
  }

  private async assertPhoneAvailable(phone: string, exceptId: number | null) {
    const matches = await this.prisma.contact.findMany({
      where: {
        phone,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (matches.length) {
      throw new ConflictException(
        `手机号已被其他联系人使用：${matches.map((row) => `${row.name}(#${row.id})`).join('、')}`,
      );
    }
  }

  private async assertMembershipDepartments(rows: NormalizedMembership[]) {
    const ids = rows.map((row) => row.departmentId);
    const departments = await this.prisma.orgDepartment.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { children: true } } },
    });
    if (departments.length !== ids.length) {
      throw new BadRequestException('所属部门不存在');
    }
    const invalid = departments.find(
      (department) => !department.isActive || department._count.children > 0,
    );
    if (invalid) {
      throw new BadRequestException(
        `员工只能归属到启用的末级部门：${invalid.name}`,
      );
    }
  }

  private async backfillLegacyDepartments() {
    const contacts = await this.prisma.contact.findMany({
      where: {
        department: { not: null },
        memberships: { none: {} },
      },
      select: { id: true, department: true },
    });
    for (const contact of contacts) {
      const parts = splitDepartmentPath(contact.department);
      if (!parts.length) continue;
      await this.prisma.$transaction(async (tx) => {
        const department = await this.ensureDepartmentPath(tx, parts);
        await tx.contactDepartmentMembership.create({
          data: {
            contactId: contact.id,
            departmentId: department.id,
            isPrimary: true,
            defaultEvalEnabled: true,
          },
        });
      });
    }
  }

  private async ensureDepartmentPath(
    tx: Prisma.TransactionClient,
    parts: string[],
  ) {
    let parentId: number | null = null;
    let parentCode = 'ROOT';
    let current: DepartmentRow | null = null;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      current = await tx.orgDepartment.findFirst({
        where: { parentId, name },
      });
      if (!current) {
        const code = this.legacyDepartmentCode(parentCode, name);
        current = await tx.orgDepartment.upsert({
          where: { code },
          create: { code, name, parentId, sortOrder: index },
          update: {},
        });
      }
      parentId = current.id;
      parentCode = current.code;
    }
    return current!;
  }

  private async syncLegacyDepartmentsForSubtree(rootId: number) {
    const ids = await this.collectSubtreeIds(rootId);
    const memberships = await this.prisma.contactDepartmentMembership.findMany({
      where: { departmentId: { in: ids }, isPrimary: true },
      select: { contactId: true, departmentId: true },
    });
    const departments = await this.prisma.orgDepartment.findMany();
    const pathMap = this.departmentPathMap(departments);
    await this.prisma.$transaction(
      memberships.map((membership) =>
        this.prisma.contact.update({
          where: { id: membership.contactId },
          data: { department: pathMap.get(membership.departmentId) || null },
        }),
      ),
    );
  }

  private async assertDepartmentParent(parentId: number | null) {
    if (parentId === null) return;
    const parent = await this.requireDepartment(parentId);
    if (!parent.isActive) throw new BadRequestException('父部门已停用');
    const memberCount = await this.prisma.contactDepartmentMembership.count({
      where: { departmentId: parentId },
    });
    if (memberCount) {
      throw new ConflictException(
        '该部门已有员工，必须先迁移员工后才能新增下级部门',
      );
    }
  }

  private async assertSiblingNameAvailable(
    parentId: number | null,
    name: string,
    exceptId?: number,
  ) {
    const existing = await this.prisma.orgDepartment.findFirst({
      where: {
        parentId,
        name,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (existing) throw new ConflictException('同级部门中已存在相同名称');
  }

  private async requireDepartment(id: number) {
    const department = await this.prisma.orgDepartment.findUnique({
      where: { id },
    });
    if (!department) throw new NotFoundException('部门不存在');
    return department;
  }

  private async requireContact(id: number) {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact) throw new NotFoundException('联系人不存在');
    return contact;
  }

  private async collectDescendantIds(id: number) {
    return (await this.collectSubtreeIds(id)).filter((item) => item !== id);
  }

  private async collectSubtreeIds(id: number) {
    const departments = await this.prisma.orgDepartment.findMany({
      select: { id: true, parentId: true },
    });
    if (!departments.some((row) => row.id === id)) {
      throw new NotFoundException('部门不存在');
    }
    const children = new Map<number, number[]>();
    for (const department of departments) {
      if (department.parentId === null) continue;
      const rows = children.get(department.parentId) || [];
      rows.push(department.id);
      children.set(department.parentId, rows);
    }
    const result: number[] = [];
    const queue = [id];
    while (queue.length) {
      const current = queue.shift()!;
      result.push(current);
      queue.push(...(children.get(current) || []));
    }
    return result;
  }

  private buildDepartmentTree(
    departments: DepartmentRow[],
    directCounts: Map<number, number>,
  ) {
    const pathMap = this.departmentPathMap(departments);
    const children = new Map<number | null, DepartmentRow[]>();
    for (const department of departments) {
      const rows = children.get(department.parentId) || [];
      rows.push(department);
      children.set(department.parentId, rows);
    }
    const visit = (department: DepartmentRow): DepartmentView => {
      const childViews = (children.get(department.id) || []).map(visit);
      const directMemberCount = directCounts.get(department.id) || 0;
      return {
        ...department,
        path: pathMap.get(department.id) || department.name,
        isLeaf: childViews.length === 0,
        directMemberCount,
        totalMemberCount:
          directMemberCount +
          childViews.reduce((sum, child) => sum + child.totalMemberCount, 0),
        children: childViews,
      };
    };
    return (children.get(null) || []).map(visit);
  }

  private departmentPathMap(departments: DepartmentRow[]) {
    const byId = new Map(departments.map((row) => [row.id, row]));
    const cache = new Map<number, string>();
    const resolve = (id: number, seen = new Set<number>()): string => {
      const cached = cache.get(id);
      if (cached) return cached;
      if (seen.has(id)) return '组织结构异常';
      seen.add(id);
      const current = byId.get(id);
      if (!current) return '';
      const parentPath = current.parentId
        ? resolve(current.parentId, seen)
        : '';
      const path = parentPath ? `${parentPath}/${current.name}` : current.name;
      cache.set(id, path);
      return path;
    };
    departments.forEach((row) => resolve(row.id));
    return cache;
  }

  private async departmentPath(
    tx: Prisma.TransactionClient,
    departmentId: number,
  ) {
    const departments = await tx.orgDepartment.findMany();
    return this.departmentPathMap(departments).get(departmentId) || null;
  }

  private optionalPositiveId(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${label}不合法`);
    }
    return parsed;
  }

  private integerOrDefault(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  }

  private newDepartmentCode() {
    return `D${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private legacyDepartmentCode(parentCode: string, name: string) {
    return `L${createHash('sha256').update(`${parentCode}/${name}`).digest('hex').slice(0, 24).toUpperCase()}`;
  }

  private handleDepartmentWriteError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('部门编码或同级部门名称已存在');
    }
    throw error;
  }
}
