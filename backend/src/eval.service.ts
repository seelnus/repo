import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, SurveyStatus, SurveyType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';
import { calculateEmployeeScore } from './eval-scoring';
import {
  buildMultiGroupAutoRelations,
  findSharedEnabledGroups,
  type MultiGroupParticipant,
  type ParticipantGroupSnapshotInput,
} from './eval-participant-groups';
import {
  EVAL_CYCLE_STATUSES,
  EvalAnswer,
  EvalCycleStatus,
  EvalResponseForScoring,
  EvalTemplate,
  normalizeEvalTemplate,
} from './eval.types';

// 填写端用户（由 FillAuthGuard 注入，sub = 联系人 id）
export interface EvalFillUser {
  sub: number;
  wecomUserid: string;
  name: string;
  type: 'fill';
}

// 领导识别：联系人 tags 含"领导"二字即视为领导（按人绑定，全局标记）
export const LEADER_TAG = '领导';
export function isLeaderTag(tags: string | null | undefined): boolean {
  return !!tags && tags.includes(LEADER_TAG);
}

export type AutoRelation = {
  rater: number;
  ratee: number;
  type: 'self' | 'peer';
  surveyId: number;
};

type SnapshotDepartment = {
  id: number;
  code: string;
  name: string;
  parentId: number | null;
  isActive: boolean;
};

type PlannedParticipantGroup = ParticipantGroupSnapshotInput & {
  departmentCodeSnapshot: string;
  roleNameSnapshot: string | null;
};

type PlannedParticipant = {
  contactId: number;
  nameSnapshot: string;
  jobNoSnapshot: string | null;
  departmentSnapshot: string;
  positionSnapshot: string | null;
  groupKey: string;
  groupName: string;
  groups: PlannedParticipantGroup[];
};

export type DepartmentResultParticipant = {
  contactId: number;
  departmentSnapshot?: string | null;
  groupSnapshots?: Array<{
    departmentPathSnapshot?: string | null;
  }>;
  result?: {
    totalScore?: unknown;
    dimensionScoresJson?: unknown;
  } | null;
};

export type DepartmentSummaryRow = {
  level: number;
  name: string;
  path: string;
  participantCount: number;
  scoredParticipantCount: number;
  dimensionAverages: Record<string, number | null>;
  totalAverage: number | null;
};

function parseDepartmentPath(path: unknown): string[] {
  return String(path || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function finiteScore(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildDepartmentSummaryRows(
  participants: DepartmentResultParticipant[],
  dimensionIds: string[],
): DepartmentSummaryRow[] {
  type Aggregate = {
    level: number;
    name: string;
    path: string;
    participantIds: Set<number>;
    scoredParticipantIds: Set<number>;
    totalSum: number;
    totalCount: number;
    dimensionSums: Map<string, number>;
    dimensionCounts: Map<string, number>;
  };

  const aggregates = new Map<string, Aggregate>();

  for (const participant of participants) {
    const snapshotPaths = (participant.groupSnapshots || [])
      .map((snapshot) => parseDepartmentPath(snapshot.departmentPathSnapshot))
      .filter((parts) => parts.length > 0);
    const paths = snapshotPaths.length
      ? snapshotPaths
      : [parseDepartmentPath(participant.departmentSnapshot || '未分组')];
    const participantNodePaths = new Set<string>();

    for (const parts of paths) {
      for (let index = 0; index < parts.length; index += 1) {
        participantNodePaths.add(parts.slice(0, index + 1).join('/'));
      }
    }

    const totalScore = finiteScore(participant.result?.totalScore);
    const dimensionScores = new Map<string, number>();
    if (totalScore !== null && Array.isArray(participant.result?.dimensionScoresJson)) {
      for (const item of participant.result.dimensionScoresJson as Array<{
        dimensionId?: unknown;
        score?: unknown;
      }>) {
        const dimensionId = String(item?.dimensionId || '');
        const score = finiteScore(item?.score);
        if (dimensionId && score !== null) dimensionScores.set(dimensionId, score);
      }
    }

    for (const path of participantNodePaths) {
      const parts = parseDepartmentPath(path);
      if (!parts.length) continue;
      if (!aggregates.has(path)) {
        aggregates.set(path, {
          level: parts.length,
          name: parts[parts.length - 1],
          path,
          participantIds: new Set(),
          scoredParticipantIds: new Set(),
          totalSum: 0,
          totalCount: 0,
          dimensionSums: new Map(),
          dimensionCounts: new Map(),
        });
      }
      const aggregate = aggregates.get(path)!;
      aggregate.participantIds.add(participant.contactId);
      if (totalScore === null) continue;

      aggregate.scoredParticipantIds.add(participant.contactId);
      aggregate.totalSum += totalScore;
      aggregate.totalCount += 1;
      for (const dimensionId of dimensionIds) {
        const score = dimensionScores.get(dimensionId);
        if (score === undefined) continue;
        aggregate.dimensionSums.set(
          dimensionId,
          (aggregate.dimensionSums.get(dimensionId) || 0) + score,
        );
        aggregate.dimensionCounts.set(
          dimensionId,
          (aggregate.dimensionCounts.get(dimensionId) || 0) + 1,
        );
      }
    }
  }

  return Array.from(aggregates.values()).map((aggregate) => ({
    level: aggregate.level,
    name: aggregate.name,
    path: aggregate.path,
    participantCount: aggregate.participantIds.size,
    scoredParticipantCount: aggregate.scoredParticipantIds.size,
    dimensionAverages: Object.fromEntries(
      dimensionIds.map((dimensionId) => {
        const count = aggregate.dimensionCounts.get(dimensionId) || 0;
        return [
          dimensionId,
          count
            ? (aggregate.dimensionSums.get(dimensionId) || 0) / count
            : null,
        ];
      }),
    ),
    totalAverage: aggregate.totalCount
      ? aggregate.totalSum / aggregate.totalCount
      : null,
  }));
}

/**
 * 纯函数：给定组内成员 + 领导集合 + 两份问卷模板，算出普通员工的自评 + 互评关系。
 * 领导不进入自动网（既不评、也不被普通规则评），留给人工配置。
 * 不变式：N 个普通员工 => N 条自评 + N*(N-1) 条互评 = N^2 条。
 */
export function buildAutoRelations(
  memberIds: number[],
  leaderIds: Set<number>,
  selfSurveyId: number,
  peerSurveyId: number,
): AutoRelation[] {
  const normals = memberIds.filter((id) => !leaderIds.has(id));
  const rels: AutoRelation[] = [];
  for (const p of normals) {
    rels.push({ rater: p, ratee: p, type: 'self', surveyId: selfSurveyId });
    for (const q of normals) {
      if (q === p) continue;
      rels.push({ rater: p, ratee: q, type: 'peer', surveyId: peerSurveyId });
    }
  }
  return rels;
}

@Injectable()
export class EvalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // ── 本地测试登录（仅当 ALLOW_DEV_FILL_LOGIN=true 时可用，服务器不设置该变量即自动关闭）──

  private assertDevLoginAllowed() {
    if (process.env.ALLOW_DEV_FILL_LOGIN !== 'true') {
      throw new ForbiddenException('本地测试登录未开启（生产环境不可用）');
    }
  }

  async devListContacts() {
    this.assertDevLoginAllowed();
    const contacts = await this.prisma.contact.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, department: true },
    });
    return contacts;
  }

  async devFillLogin(contactId: number) {
    this.assertDevLoginAllowed();
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
    });
    if (!contact) throw new NotFoundException('联系人不存在');
    const token = this.jwt.sign(
      {
        sub: contact.id,
        wecomUserid: `dev-${contact.id}`,
        name: contact.name,
        type: 'fill',
      },
      { expiresIn: '24h' },
    );
    return { token, name: contact.name };
  }

  // ── 批次 CRUD ──

  async listCycles() {
    const cycles = await this.prisma.evalCycle.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { relations: true, participants: true } } },
    });
    return cycles.map(({ _count, ...c }) => ({
      ...c,
      relationCount: _count.relations,
      participantCount: _count.participants,
    }));
  }

  async getCycle(id: number) {
    const cycle = await this.prisma.evalCycle.findUnique({
      where: { id },
      include: { _count: { select: { relations: true, participants: true } } },
    });
    if (!cycle) throw new NotFoundException('评价批次不存在');
    const { _count, ...value } = cycle;
    return {
      ...value,
      relationCount: _count.relations,
      participantCount: _count.participants,
    };
  }

  async createCycle(adminId: number, data: any) {
    const name = String(data?.name || '').trim();
    if (!name) throw new BadRequestException('批次名称不能为空');
    return this.prisma.evalCycle.create({
      data: {
        name,
        version: 2,
        scopeDepartment: data.scopeDepartment
          ? String(data.scopeDepartment)
          : null,
        selfSurveyId: toIdOrNull(data.selfSurveyId),
        peerSurveyId: toIdOrNull(data.peerSurveyId),
        leaderSurveyId: toIdOrNull(data.leaderSurveyId),
        templateSurveyId: toIdOrNull(data.templateSurveyId),
        startAt: toDateOrNull(data.startAt),
        endAt: toDateOrNull(data.endAt),
        createdBy: adminId,
      },
    });
  }

  async updateCycle(id: number, data: any) {
    const cycle = await this.getCycle(id);
    const immutableChanged =
      data.templateSurveyId !== undefined ||
      data.startAt !== undefined ||
      data.name !== undefined;
    if (cycle.status !== 'draft' && immutableChanged)
      throw new BadRequestException('已发布批次不能修改名称、模板和开始时间');
    const status =
      data.status === undefined
        ? undefined
        : (String(data.status) as EvalCycleStatus);
    if (status && !EVAL_CYCLE_STATUSES.includes(status))
      throw new BadRequestException('批次状态不合法');
    if (cycle.version >= 2 && status && status !== cycle.status)
      throw new BadRequestException(
        '新版批次请使用发布、截止、锁定或归档操作变更状态',
      );
    const startAt =
      data.startAt !== undefined ? toDateOrNull(data.startAt) : undefined;
    const endAt =
      data.endAt !== undefined ? toDateOrNull(data.endAt) : undefined;
    const effectiveStart = startAt === undefined ? cycle.startAt : startAt;
    const effectiveEnd = endAt === undefined ? cycle.endAt : endAt;
    if (effectiveStart && effectiveEnd && effectiveStart >= effectiveEnd)
      throw new BadRequestException('开始时间必须早于截止时间');
    return this.prisma.evalCycle.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: String(data.name).trim() } : {}),
        ...(data.scopeDepartment !== undefined
          ? {
              scopeDepartment: data.scopeDepartment
                ? String(data.scopeDepartment)
                : null,
            }
          : {}),
        ...(data.selfSurveyId !== undefined
          ? { selfSurveyId: toIdOrNull(data.selfSurveyId) }
          : {}),
        ...(data.peerSurveyId !== undefined
          ? { peerSurveyId: toIdOrNull(data.peerSurveyId) }
          : {}),
        ...(data.leaderSurveyId !== undefined
          ? { leaderSurveyId: toIdOrNull(data.leaderSurveyId) }
          : {}),
        ...(data.templateSurveyId !== undefined
          ? { templateSurveyId: toIdOrNull(data.templateSurveyId) }
          : {}),
        ...(startAt !== undefined ? { startAt } : {}),
        ...(endAt !== undefined ? { endAt } : {}),
        ...(status !== undefined ? { status } : {}),
      },
    });
  }

  async deleteCycle(id: number) {
    const cycle = await this.getCycle(id);
    if (cycle.status !== 'draft')
      throw new BadRequestException('只有草稿批次可以删除');
    const submitted = await this.prisma.evalRelation.count({
      where: { cycleId: id, responseId: { not: null } },
    });
    if (submitted) throw new BadRequestException('批次已有答卷，不能删除');
    // eval_relations 通过外键 onDelete: Cascade 一并删除
    await this.prisma.evalCycle.delete({ where: { id } });
    return { ok: true };
  }

  // ── 新版统一模板 ──

  async listTemplates() {
    return this.prisma.survey.findMany({
      where: { type: SurveyType.evaluation, isDeleted: false },
      select: {
        id: true,
        title: true,
        status: true,
        schemaJson: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createTemplate(adminId: number, data: any) {
    const title = String(data?.title || '').trim();
    if (!title) throw new BadRequestException('模板名称不能为空');
    const schema = this.parseTemplate(data?.schemaJson);
    return this.prisma.survey.create({
      data: {
        title,
        type: SurveyType.evaluation,
        status: SurveyStatus.draft,
        schemaJson: schema as unknown as Prisma.InputJsonValue,
        shareToken: randomBytes(16).toString('hex'),
        createdBy: adminId,
      },
    });
  }

  async updateTemplate(id: number, data: any) {
    const template = await this.getTemplate(id);
    const title =
      data.title === undefined
        ? template.title
        : String(data.title || '').trim();
    if (!title) throw new BadRequestException('模板名称不能为空');
    const schema =
      data.schemaJson === undefined
        ? template.schemaJson
        : this.parseTemplate(data.schemaJson);
    return this.prisma.survey.update({
      where: { id },
      data: { title, schemaJson: schema as Prisma.InputJsonValue },
    });
  }

  private async getTemplate(id: number) {
    const template = await this.prisma.survey.findFirst({
      where: { id, type: SurveyType.evaluation, isDeleted: false },
    });
    if (!template) throw new NotFoundException('环评模板不存在');
    return template;
  }

  private parseTemplate(value: unknown): EvalTemplate {
    try {
      return normalizeEvalTemplate(value);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '环评模板格式不正确',
      );
    }
  }

  // ── 新版参评人员快照 ──

  private departmentPathMap(departments: SnapshotDepartment[]) {
    const byId = new Map(
      departments.map((department) => [department.id, department]),
    );
    const paths = new Map<number, string>();
    const resolving = new Set<number>();
    const resolve = (departmentId: number): string => {
      const cached = paths.get(departmentId);
      if (cached) return cached;
      const department = byId.get(departmentId);
      if (!department) return '';
      if (resolving.has(departmentId)) return department.name;
      resolving.add(departmentId);
      const parentPath = department.parentId
        ? resolve(department.parentId)
        : '';
      resolving.delete(departmentId);
      const path = parentPath
        ? `${parentPath}/${department.name}`
        : department.name;
      paths.set(departmentId, path);
      return path;
    };
    departments.forEach((department) => resolve(department.id));
    return paths;
  }

  private summarizeParticipantPlan(
    participants: PlannedParticipant[],
    warnings: string[],
  ) {
    const enabledGroups = new Map<
      number,
      {
        departmentId: number;
        name: string;
        path: string;
        memberIds: Set<number>;
      }
    >();
    let multiGroupParticipantCount = 0;
    for (const participant of participants) {
      const enabled = participant.groups.filter((group) => group.evalEnabled);
      if (enabled.length > 1) multiGroupParticipantCount += 1;
      for (const group of enabled) {
        const current = enabledGroups.get(group.departmentId) || {
          departmentId: group.departmentId,
          name: group.departmentNameSnapshot,
          path: group.departmentPathSnapshot,
          memberIds: new Set<number>(),
        };
        current.memberIds.add(participant.contactId);
        enabledGroups.set(group.departmentId, current);
      }
    }
    const singlePersonGroups = Array.from(enabledGroups.values())
      .filter((group) => group.memberIds.size === 1)
      .map((group) => ({
        departmentId: group.departmentId,
        name: group.name,
        path: group.path,
        contactId: Array.from(group.memberIds)[0],
      }));
    return {
      participantCount: participants.length,
      enabledGroupCount: enabledGroups.size,
      multiGroupParticipantCount,
      singlePersonGroupCount: singlePersonGroups.length,
      singlePersonGroups,
      warnings,
    };
  }

  private async planParticipantSnapshots(contactIds: number[]) {
    const [contacts, departments] = await Promise.all([
      this.prisma.contact.findMany({
        where: { id: { in: contactIds } },
        include: {
          memberships: {
            include: { department: true },
            orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
          },
        },
      }),
      this.prisma.orgDepartment.findMany(),
    ]);
    if (contacts.length !== contactIds.length) {
      throw new BadRequestException('部分联系人不存在，请刷新后重试');
    }
    const pathMap = this.departmentPathMap(departments);
    const parentIds = new Set(
      departments
        .filter((department) => department.parentId !== null)
        .map((department) => department.parentId as number),
    );
    const errors: string[] = [];
    const warnings: string[] = [];
    const participants: PlannedParticipant[] = [];

    for (const contact of contacts) {
      if (!contact.isActive) {
        errors.push(`${contact.name}：联系人已停用`);
        continue;
      }
      const departmentIds = contact.memberships.map(
        (membership) => membership.departmentId,
      );
      if (new Set(departmentIds).size !== departmentIds.length) {
        errors.push(`${contact.name}：存在重复部门归属`);
        continue;
      }
      const primaryMemberships = contact.memberships.filter(
        (membership) => membership.isPrimary,
      );
      if (primaryMemberships.length !== 1) {
        errors.push(
          `${contact.name}：需要且只能设置一个主部门（当前 ${primaryMemberships.length} 个）`,
        );
        continue;
      }
      const primary = primaryMemberships[0];
      if (!primary.department.isActive) {
        errors.push(
          `${contact.name}：主部门“${primary.department.name}”已停用`,
        );
        continue;
      }
      if (parentIds.has(primary.departmentId)) {
        warnings.push(
          `${contact.name}：主部门“${primary.department.name}”包含下级部门，仍仅按本人明确归属参与互评`,
        );
      }
      const groups = contact.memberships.map((membership) => {
        const path =
          pathMap.get(membership.departmentId) || membership.department.name;
        const evalEnabled = membership.isPrimary
          ? true
          : membership.department.isActive && membership.defaultEvalEnabled;
        if (!membership.isPrimary && !membership.department.isActive) {
          warnings.push(
            `${contact.name}：兼任部门“${path}”已停用，本批次默认关闭互评`,
          );
        }
        return {
          departmentId: membership.departmentId,
          departmentCodeSnapshot: membership.department.code,
          departmentNameSnapshot: membership.department.name,
          departmentPathSnapshot: path,
          isPrimarySnapshot: membership.isPrimary,
          evalEnabled,
          roleNameSnapshot: membership.roleName,
        };
      });
      const primaryPath =
        pathMap.get(primary.departmentId) || primary.department.name;
      participants.push({
        contactId: contact.id,
        nameSnapshot: contact.name,
        jobNoSnapshot: contact.jobNo,
        departmentSnapshot: primaryPath,
        positionSnapshot: contact.position,
        groupKey: String(primary.departmentId),
        groupName: primaryPath,
        groups,
      });
    }
    if (errors.length) throw new BadRequestException({ message: errors });
    participants.sort((left, right) => left.contactId - right.contactId);
    return {
      participants,
      summary: this.summarizeParticipantPlan(participants, warnings),
    };
  }

  private async assertParticipantSnapshotsMutable(cycleId: number) {
    const cycle = await this.requireDraftCycle(cycleId);
    const submitted = await this.prisma.evalRelation.count({
      where: { cycleId, responseId: { not: null } },
    });
    if (submitted) throw new BadRequestException('已有答卷，不能调整参评人员');
    return cycle;
  }

  async getParticipantCandidates() {
    const [contacts, departments] = await Promise.all([
      this.prisma.contact.findMany({
        where: { isActive: true },
        include: {
          memberships: {
            include: { department: true },
            orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.orgDepartment.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const pathMap = this.departmentPathMap(departments);
    const departmentCounts = new Map<number, Set<number>>();
    for (const contact of contacts) {
      for (const membership of contact.memberships) {
        if (!membership.department.isActive) continue;
        const members =
          departmentCounts.get(membership.departmentId) || new Set();
        members.add(contact.id);
        departmentCounts.set(membership.departmentId, members);
      }
    }
    return {
      departments: departments
        .filter((department) => department.isActive)
        .map((department) => ({
          id: department.id,
          name: department.name,
          path: pathMap.get(department.id) || department.name,
          count: departmentCounts.get(department.id)?.size || 0,
        })),
      contacts: contacts.map((contact) => ({
        ...contact,
        memberships: contact.memberships.map((membership) => ({
          departmentId: membership.departmentId,
          departmentName: membership.department.name,
          departmentPath:
            pathMap.get(membership.departmentId) || membership.department.name,
          isPrimary: membership.isPrimary,
          defaultEvalEnabled: membership.isPrimary
            ? true
            : membership.defaultEvalEnabled,
          roleName: membership.roleName,
          isActive: membership.department.isActive,
        })),
      })),
    };
  }

  async listParticipants(cycleId: number) {
    await this.getCycle(cycleId);
    const [participants, latestAutoRelation, latestGroupSnapshot] =
      await Promise.all([
        this.prisma.evalCycleParticipant.findMany({
          where: { cycleId },
          include: {
            groupSnapshots: {
              orderBy: [{ isPrimarySnapshot: 'desc' }, { id: 'asc' }],
            },
          },
          orderBy: [{ groupName: 'asc' }, { nameSnapshot: 'asc' }],
        }),
        this.prisma.evalRelation.aggregate({
          where: { cycleId, source: 'auto' },
          _max: { createdAt: true },
        }),
        this.prisma.evalParticipantGroupSnapshot.aggregate({
          where: { participant: { cycleId } },
          _max: { updatedAt: true },
        }),
      ]);
    const autoCreatedAt = latestAutoRelation._max.createdAt;
    const groupUpdatedAt = latestGroupSnapshot._max.updatedAt;
    const relationsNeedRegeneration =
      participants.length > 0 &&
      (!autoCreatedAt ||
        (!!groupUpdatedAt &&
          groupUpdatedAt.getTime() > autoCreatedAt.getTime()));
    return participants.map((participant) => ({
      ...participant,
      groups: participant.groupSnapshots,
      relationsNeedRegeneration,
    }));
  }

  async previewParticipants(cycleId: number, data: any) {
    await this.assertParticipantSnapshotsMutable(cycleId);
    const contactIds = uniquePositiveIds(data?.contactIds || []);
    if (!contactIds.length)
      throw new BadRequestException('请至少选择一名参评人员');
    const planned = await this.planParticipantSnapshots(contactIds);
    return planned.summary;
  }

  async replaceParticipants(cycleId: number, data: any, adminId: number) {
    const cycle = await this.assertParticipantSnapshotsMutable(cycleId);
    const contactIds = uniquePositiveIds(data?.contactIds || []);
    if (!contactIds.length)
      throw new BadRequestException('请至少选择一名参评人员');
    const planned = await this.planParticipantSnapshots(contactIds);
    let deletedManualCount = 0;
    let preservedManualCount = 0;
    await this.prisma.$transaction(async (tx) => {
      const existingParticipants = await tx.evalCycleParticipant.findMany({
        where: { cycleId, contactId: { in: contactIds } },
        select: {
          contactId: true,
          mode: true,
          peerExempt: true,
          exceptionReason: true,
        },
      });
      const existingSettings = new Map(
        existingParticipants.map((participant) => [
          participant.contactId,
          participant,
        ]),
      );
      await tx.evalRelation.deleteMany({
        where: { cycleId, source: 'auto' },
      });
      const removedManual = await tx.evalRelation.deleteMany({
        where: {
          cycleId,
          source: 'manual',
          OR: [
            { raterContactId: { notIn: contactIds } },
            { rateeContactId: { notIn: contactIds } },
          ],
        },
      });
      deletedManualCount = removedManual.count;
      preservedManualCount = await tx.evalRelation.count({
        where: { cycleId, source: 'manual' },
      });
      await tx.evalCycleParticipant.deleteMany({ where: { cycleId } });
      for (const participant of planned.participants) {
        const previous = existingSettings.get(participant.contactId);
        await tx.evalCycleParticipant.create({
          data: {
            cycleId,
            contactId: participant.contactId,
            nameSnapshot: participant.nameSnapshot,
            jobNoSnapshot: participant.jobNoSnapshot,
            departmentSnapshot: participant.departmentSnapshot,
            positionSnapshot: participant.positionSnapshot,
            groupKey: participant.groupKey,
            groupName: participant.groupName,
            mode: previous?.mode || 'normal',
            peerExempt: previous?.peerExempt || false,
            exceptionReason: previous?.exceptionReason || null,
            groupSnapshots: {
              create: participant.groups,
            },
          },
        });
      }
      await tx.evalAuditLog.create({
        data: {
          cycleId,
          action: 'replace_participants',
          targetType: 'cycle_participants',
          afterJson: {
            contactIds,
            ...planned.summary,
            preservedManualCount,
            deletedManualCount,
          } as Prisma.InputJsonValue,
          adminId,
        },
      });
    });
    return {
      cycleId: cycle.id,
      count: planned.participants.length,
      ...planned.summary,
      preservedManualCount,
      deletedManualCount,
      relationsNeedRegeneration: true,
    };
  }

  async copyParticipants(
    cycleId: number,
    sourceCycleId: number,
    adminId: number,
  ) {
    await this.requireDraftCycle(cycleId);
    const source = await this.prisma.evalCycleParticipant.findMany({
      where: { cycleId: sourceCycleId },
    });
    if (!source.length)
      throw new BadRequestException('来源批次没有可复制的参评人员');
    return this.replaceParticipants(
      cycleId,
      {
        contactIds: source.map((participant) => participant.contactId),
      },
      adminId,
    );
  }

  async updateParticipantGroups(
    cycleId: number,
    participantId: number,
    data: any,
    adminId: number,
  ) {
    await this.assertParticipantSnapshotsMutable(cycleId);
    const participant = await this.prisma.evalCycleParticipant.findFirst({
      where: { id: participantId, cycleId },
      include: { groupSnapshots: true },
    });
    if (!participant) throw new NotFoundException('参评人员不存在');
    if (!participant.groupSnapshots.length) {
      throw new BadRequestException(
        '历史批次没有多部门快照，请先重新确认人员范围',
      );
    }
    const requested = Array.isArray(data?.groups) ? data.groups : [];
    const requestedByDepartment = new Map<number, boolean>();
    for (const item of requested) {
      const departmentId = Number(item?.departmentId);
      if (!Number.isInteger(departmentId) || departmentId <= 0) {
        throw new BadRequestException('部门参数不合法');
      }
      requestedByDepartment.set(departmentId, Boolean(item?.evalEnabled));
    }
    const knownIds = new Set(
      participant.groupSnapshots.map((group) => group.departmentId),
    );
    const unknownId = Array.from(requestedByDepartment.keys()).find(
      (departmentId) => !knownIds.has(departmentId),
    );
    if (unknownId) {
      throw new BadRequestException('只能调整当前批次已经快照的兼任部门');
    }
    const before = participant.groupSnapshots;
    await this.prisma.$transaction(async (tx) => {
      for (const group of participant.groupSnapshots) {
        const requestedEnabled = requestedByDepartment.get(group.departmentId);
        const evalEnabled = group.isPrimarySnapshot
          ? true
          : requestedEnabled === undefined
            ? group.evalEnabled
            : requestedEnabled;
        if (evalEnabled !== group.evalEnabled) {
          await tx.evalParticipantGroupSnapshot.update({
            where: { id: group.id },
            data: { evalEnabled },
          });
        }
      }
      const after = participant.groupSnapshots.map((group) => ({
        ...group,
        evalEnabled: group.isPrimarySnapshot
          ? true
          : (requestedByDepartment.get(group.departmentId) ??
            group.evalEnabled),
      }));
      await tx.evalAuditLog.create({
        data: {
          cycleId,
          action: 'update_participant_groups',
          targetType: 'participant',
          targetId: String(participantId),
          beforeJson: toJsonInput(before),
          afterJson: toJsonInput(after),
          adminId,
        },
      });
    });
    return { ok: true, relationsNeedRegeneration: true };
  }

  async updateParticipant(
    cycleId: number,
    participantId: number,
    data: any,
    adminId: number,
  ) {
    await this.requireDraftCycle(cycleId);
    const participant = await this.prisma.evalCycleParticipant.findFirst({
      where: { id: participantId, cycleId },
    });
    if (!participant) throw new NotFoundException('参评人员不存在');
    const mode = data.mode === undefined ? participant.mode : String(data.mode);
    if (!['normal', 'special'].includes(mode))
      throw new BadRequestException('人员类型不合法');
    const groupName =
      data.groupName === undefined
        ? participant.groupName
        : String(data.groupName || '').trim();
    if (!groupName) throw new BadRequestException('评价小组不能为空');
    const updated = await this.prisma.evalCycleParticipant.update({
      where: { id: participantId },
      data: {
        mode,
        groupName,
        groupKey: groupName,
        ...(data.peerExempt !== undefined
          ? { peerExempt: Boolean(data.peerExempt) }
          : {}),
        ...(data.exceptionReason !== undefined
          ? {
              exceptionReason:
                String(data.exceptionReason || '').trim() || null,
            }
          : {}),
      },
    });
    if (mode !== participant.mode) {
      await this.prisma.evalRelation.deleteMany({
        where: {
          cycleId,
          source: 'auto',
          OR: [
            { raterContactId: participant.contactId },
            { rateeContactId: participant.contactId },
          ],
        },
      });
    }
    await this.prisma.evalAuditLog.create({
      data: {
        cycleId,
        action: 'update_participant',
        targetType: 'participant',
        targetId: String(participantId),
        beforeJson: toJsonInput(participant),
        afterJson: toJsonInput(updated),
        adminId,
      },
    });
    return updated;
  }

  private async requireDraftCycle(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.status !== 'draft')
      throw new BadRequestException('只有草稿批次允许执行该操作');
    return cycle;
  }

  // ── 关系自动生成 ──

  /**
   * 按 department 分组，为范围内普通员工生成自评 + 互评关系。
   * 只覆盖 source=auto 的记录（重新生成时不冲掉 source=manual 的人工配置）。
   */
  async generateRelations(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.version >= 2) return this.generateV2Relations(cycleId);
    if (!cycle.scopeDepartment)
      throw new BadRequestException('请先设置参评范围（部门/组）');
    if (!cycle.selfSurveyId || !cycle.peerSurveyId) {
      throw new BadRequestException('请先绑定自评问卷和他评问卷');
    }

    const members = await this.prisma.contact.findMany({
      where: { department: cycle.scopeDepartment },
      orderBy: { id: 'asc' },
    });
    const leaderIds = new Set(
      members.filter((m) => isLeaderTag(m.tags)).map((m) => m.id),
    );
    const memberIds = members.map((m) => m.id);

    const rels = buildAutoRelations(
      memberIds,
      leaderIds,
      cycle.selfSurveyId,
      cycle.peerSurveyId,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.evalRelation.deleteMany({ where: { cycleId, source: 'auto' } });
      if (rels.length > 0) {
        await tx.evalRelation.createMany({
          data: rels.map((r) => ({
            cycleId,
            raterContactId: r.rater,
            rateeContactId: r.ratee,
            relationType: r.type,
            surveyId: r.surveyId,
            source: 'auto',
          })),
          skipDuplicates: true, // 不覆盖已存在的人工配置（唯一键 cycle+rater+ratee）
        });
      }
    });

    const normalCount = memberIds.length - leaderIds.size;
    const selfCount = rels.filter((r) => r.type === 'self').length;
    const peerCount = rels.filter((r) => r.type === 'peer').length;

    // 生成报告：把规则覆盖不到、需人工处理的显式列出来
    const warnings: string[] = [];
    if (normalCount === 1)
      warnings.push(
        '该组只有 1 名普通员工，无法互评，请人工配置（跨组/豁免/仅自评）',
      );
    if (normalCount === 0)
      warnings.push(
        '该范围内没有普通员工（可能全是领导或范围为空），请检查参评范围与领导标记',
      );

    return {
      cycleId,
      scopeDepartment: cycle.scopeDepartment,
      memberTotal: memberIds.length,
      leaderCount: leaderIds.size,
      normalCount,
      generated: rels.length,
      selfCount,
      peerCount,
      leaderContactIds: Array.from(leaderIds),
      warnings,
    };
  }

  private async generateV2Relations(cycleId: number) {
    const cycle = await this.requireDraftCycle(cycleId);
    if (!cycle.templateSurveyId)
      throw new BadRequestException('请先选择统一环评模板');
    await this.getTemplate(cycle.templateSurveyId);
    const participants = await this.prisma.evalCycleParticipant.findMany({
      where: { cycleId },
      include: { groupSnapshots: true },
      orderBy: { id: 'asc' },
    });
    if (!participants.length) throw new BadRequestException('请先确认参评人员');
    if (participants.some((participant) => !participant.groupName.trim()))
      throw new BadRequestException('所有参评人员必须设置评价小组');
    const submitted = await this.prisma.evalRelation.count({
      where: { cycleId, responseId: { not: null } },
    });
    if (submitted)
      throw new BadRequestException('批次已有答卷，不能重新生成关系');

    const participantsWithSnapshots = participants.filter(
      (participant) => participant.groupSnapshots.length > 0,
    ).length;
    if (
      participantsWithSnapshots > 0 &&
      participantsWithSnapshots !== participants.length
    ) {
      throw new BadRequestException(
        '部分参评人员缺少多部门快照，请重新确认人员范围',
      );
    }

    const legacyDepartmentIds = new Map<string, number>();
    const generationInput: MultiGroupParticipant[] = participants.map(
      (participant) => {
        let groups: ParticipantGroupSnapshotInput[] =
          participant.groupSnapshots;
        if (!groups.length) {
          if (!legacyDepartmentIds.has(participant.groupKey)) {
            legacyDepartmentIds.set(
              participant.groupKey,
              -(legacyDepartmentIds.size + 1),
            );
          }
          groups = [
            {
              departmentId: legacyDepartmentIds.get(participant.groupKey)!,
              departmentNameSnapshot: participant.groupName,
              departmentPathSnapshot: participant.groupName,
              isPrimarySnapshot: true,
              evalEnabled: true,
            },
          ];
        }
        return {
          participantId: participant.id,
          contactId: participant.contactId,
          mode: participant.mode,
          groups,
        };
      },
    );
    const report = buildMultiGroupAutoRelations(generationInput);
    const manualRelations = await this.prisma.evalRelation.findMany({
      where: { cycleId, source: 'manual' },
      select: { raterContactId: true, rateeContactId: true },
    });
    const manualKeys = new Set(
      manualRelations.map(
        (relation) => `${relation.raterContactId}:${relation.rateeContactId}`,
      ),
    );
    const generatedRelations = report.relations.filter(
      (relation) =>
        !manualKeys.has(
          `${relation.raterContactId}:${relation.rateeContactId}`,
        ),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.evalRelation.deleteMany({ where: { cycleId, source: 'auto' } });
      if (generatedRelations.length) {
        await tx.evalRelation.createMany({
          data: generatedRelations.map((relation) => ({
            cycleId,
            raterContactId: relation.raterContactId,
            rateeContactId: relation.rateeContactId,
            relationType: relation.relationType,
            surveyId: cycle.templateSurveyId!,
            source: 'auto',
            status: 'pending',
          })),
          skipDuplicates: true,
        });
      }
    });
    return {
      cycleId,
      memberTotal: participants.length,
      specialCount: participants.filter(
        (participant) => participant.mode === 'special',
      ).length,
      normalCount: participants.filter(
        (participant) => participant.mode === 'normal',
      ).length,
      generated: generatedRelations.length,
      selfCount: generatedRelations.filter(
        (relation) => relation.relationType === 'self',
      ).length,
      peerCount: generatedRelations.filter(
        (relation) => relation.relationType === 'peer',
      ).length,
      coveredGroupCount: report.coveredGroupCount,
      groups: report.groupReports,
      warnings: report.warnings,
    };
  }

  // ── 复核列表 = 异常报告（实时聚合，不落快照）──

  async getReviewList(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.version >= 2) return this.getV2ReviewList(cycleId);
    const relations = await this.prisma.evalRelation.findMany({
      where: { cycleId },
    });

    // 行集合 = 参评范围成员 ∪ 关系里出现过的所有人（含人工配置到范围外的人）
    const scopeMembers = cycle.scopeDepartment
      ? await this.prisma.contact.findMany({
          where: { department: cycle.scopeDepartment },
        })
      : [];
    const ids = new Set<number>();
    scopeMembers.forEach((m) => ids.add(m.id));
    relations.forEach((r) => {
      ids.add(r.raterContactId);
      ids.add(r.rateeContactId);
    });
    const contacts = await this.prisma.contact.findMany({
      where: { id: { in: Array.from(ids) } },
    });
    const contactMap = new Map(contacts.map((c) => [c.id, c]));

    const rows = Array.from(ids).map((id) => {
      const c = contactMap.get(id);
      const isLeader = isLeaderTag(c?.tags);
      const involved = relations.filter(
        (r) => r.raterContactId === id || r.rateeContactId === id,
      );
      const selfRel = relations.find(
        (r) =>
          r.relationType === 'self' &&
          r.raterContactId === id &&
          r.rateeContactId === id,
      );
      const ratedBy = relations.filter(
        (r) => r.rateeContactId === id && r.raterContactId !== id,
      ); // 别人评他
      const rating = relations.filter(
        (r) => r.raterContactId === id && r.rateeContactId !== id,
      ); // 他评别人
      const sources = new Set(involved.map((r) => r.source));
      const source =
        involved.length === 0
          ? 'none'
          : sources.size > 1
            ? 'mixed'
            : Array.from(sources)[0];

      const anomalies: string[] = [];
      if (involved.length === 0) {
        anomalies.push(isLeader ? '领导待配' : '双漏');
      } else {
        if (!selfRel) anomalies.push('未配自评');
        if (ratedBy.length === 0) anomalies.push('无人评价');
      }
      if (!c?.department) anomalies.push('未归组');

      return {
        contactId: id,
        name: c?.name ?? `#${id}`,
        department: c?.department ?? null,
        position: c?.position ?? null,
        isLeader,
        hasSelf: !!selfRel,
        selfSubmitted: !!selfRel?.responseId,
        ratedByCount: ratedBy.length,
        ratedBySubmitted: ratedBy.filter((r) => r.responseId).length,
        ratingCount: rating.length,
        ratingSubmitted: rating.filter((r) => r.responseId).length,
        source,
        anomalies,
        status: anomalies.length ? '异常' : '完整',
      };
    });
    rows.sort((a, b) =>
      a.status === b.status
        ? a.contactId - b.contactId
        : a.status === '异常'
          ? -1
          : 1,
    );

    const has = (t: string) =>
      rows.filter((r) => r.anomalies.includes(t)).length;
    const summary = {
      total: rows.length,
      complete: rows.filter((r) => r.status === '完整').length,
      anomaly: rows.filter((r) => r.status === '异常').length,
      byType: {
        未配自评: has('未配自评'),
        无人评价: has('无人评价'),
        领导待配: has('领导待配'),
        双漏: has('双漏'),
        未归组: has('未归组'),
      },
    };
    return { cycle, summary, rows };
  }

  private async getV2ReviewList(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    const [participants, relations] = await Promise.all([
      this.prisma.evalCycleParticipant.findMany({
        where: { cycleId },
        include: {
          groupSnapshots: {
            orderBy: [{ isPrimarySnapshot: 'desc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ groupName: 'asc' }, { nameSnapshot: 'asc' }],
      }),
      this.prisma.evalRelation.findMany({ where: { cycleId } }),
    ]);
    const participantIds = new Set(
      participants.map((participant) => participant.contactId),
    );
    const rows = participants.map((participant) => {
      const selfRelation = relations.find(
        (relation) =>
          relation.relationType === 'self' &&
          relation.raterContactId === participant.contactId &&
          relation.rateeContactId === participant.contactId,
      );
      const received = relations.filter(
        (relation) =>
          relation.rateeContactId === participant.contactId &&
          relation.status !== 'exempt',
      );
      const assigned = relations.filter(
        (relation) =>
          relation.raterContactId === participant.contactId &&
          relation.status !== 'exempt',
      );
      const otherReceived = received.filter(
        (relation) => relation.raterContactId !== participant.contactId,
      );
      const anomalies: string[] = [];
      if (!participant.groupName.trim()) anomalies.push('未归组');
      if (participant.mode === 'normal' && !selfRelation)
        anomalies.push('未配自评');
      if (!otherReceived.length && !participant.peerExempt)
        anomalies.push(
          participant.mode === 'special' ? '特殊人员待配' : '无人评价',
        );
      if (
        !assigned.length &&
        participant.mode === 'special' &&
        !participant.exceptionReason
      )
        anomalies.push('特殊人员待配');
      const outside = relations.some(
        (relation) =>
          (relation.raterContactId === participant.contactId ||
            relation.rateeContactId === participant.contactId) &&
          (!participantIds.has(relation.raterContactId) ||
            !participantIds.has(relation.rateeContactId)),
      );
      if (outside) anomalies.push('关系指向非本批次人员');
      return {
        participantId: participant.id,
        contactId: participant.contactId,
        name: participant.nameSnapshot,
        jobNo: participant.jobNoSnapshot,
        department: participant.departmentSnapshot,
        groupName: participant.groupName,
        groups: participant.groupSnapshots,
        mode: participant.mode,
        peerExempt: participant.peerExempt,
        hasSelf: !!selfRelation,
        selfSubmitted: !!selfRelation?.responseId,
        ratedByCount: received.length,
        ratedBySubmitted: received.filter(
          (relation) => relation.responseId && relation.status === 'submitted',
        ).length,
        ratingCount: assigned.length,
        ratingSubmitted: assigned.filter(
          (relation) => relation.responseId && relation.status === 'submitted',
        ).length,
        anomalies: Array.from(new Set(anomalies)),
        status: anomalies.length ? '异常' : '完整',
      };
    });
    const summary = {
      total: rows.length,
      complete: rows.filter((row) => row.status === '完整').length,
      anomaly: rows.filter((row) => row.status === '异常').length,
      byType: {
        未配自评: rows.filter((row) => row.anomalies.includes('未配自评'))
          .length,
        无人评价: rows.filter((row) => row.anomalies.includes('无人评价'))
          .length,
        特殊人员待配: rows.filter((row) =>
          row.anomalies.includes('特殊人员待配'),
        ).length,
        未归组: rows.filter((row) => row.anomalies.includes('未归组')).length,
        关系指向非本批次人员: rows.filter((row) =>
          row.anomalies.includes('关系指向非本批次人员'),
        ).length,
      },
    };
    return { cycle, summary, rows };
  }

  // ── 关系明细 / 人工配置（领导 + 异常补配）──

  async listRelations(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    const relations = await this.prisma.evalRelation.findMany({
      where: { cycleId },
      orderBy: { id: 'asc' },
    });
    const ids = new Set<number>();
    relations.forEach((r) => {
      ids.add(r.raterContactId);
      ids.add(r.rateeContactId);
    });
    const [contacts, participants] = await Promise.all([
      this.prisma.contact.findMany({ where: { id: { in: Array.from(ids) } } }),
      this.prisma.evalCycleParticipant.findMany({
        where: { cycleId },
        include: { groupSnapshots: true },
      }),
    ]);
    const nameOf = new Map(contacts.map((c) => [c.id, c.name]));
    for (const participant of participants)
      nameOf.set(participant.contactId, participant.nameSnapshot);
    const participantByContactId = new Map(
      participants.map((participant) => [participant.contactId, participant]),
    );
    return relations.map((r) => {
      let sharedGroups: Array<{
        departmentId: number | null;
        name: string;
        path: string;
      }> = [];
      if (r.source === 'auto' && r.relationType === 'peer') {
        const rater = participantByContactId.get(r.raterContactId);
        const ratee = participantByContactId.get(r.rateeContactId);
        if (rater && ratee) {
          if (rater.groupSnapshots.length && ratee.groupSnapshots.length) {
            sharedGroups = findSharedEnabledGroups(
              rater.groupSnapshots,
              ratee.groupSnapshots,
            );
          } else if (rater.groupKey === ratee.groupKey) {
            sharedGroups = [
              {
                departmentId: null,
                name: rater.groupName,
                path: rater.groupName,
              },
            ];
          }
        }
      }
      return {
        ...r,
        raterName: nameOf.get(r.raterContactId) ?? `#${r.raterContactId}`,
        rateeName: nameOf.get(r.rateeContactId) ?? `#${r.rateeContactId}`,
        raterDepartment:
          participantByContactId.get(r.raterContactId)?.departmentSnapshot ||
          participantByContactId.get(r.raterContactId)?.groupName ||
          '',
        rateeDepartment:
          participantByContactId.get(r.rateeContactId)?.departmentSnapshot ||
          participantByContactId.get(r.rateeContactId)?.groupName ||
          '',
        sharedGroups,
        done: !!r.responseId,
      };
    });
  }

  async addManualRelation(cycleId: number, data: any) {
    const cycle = await this.getCycle(cycleId);
    if (!['draft', 'published'].includes(cycle.status))
      throw new BadRequestException('当前批次状态不能新增关系');
    const rater = Number(data?.raterContactId);
    const ratee = Number(data?.rateeContactId);
    const relationType = String(data?.relationType || '');
    if (!['self', 'peer', 'leader'].includes(relationType))
      throw new BadRequestException('关系类型必须是 self/peer/leader');
    if (
      !Number.isInteger(rater) ||
      rater <= 0 ||
      !Number.isInteger(ratee) ||
      ratee <= 0
    ) {
      throw new BadRequestException('评价人/被评人不合法');
    }
    if (relationType === 'self' && rater !== ratee)
      throw new BadRequestException('自评的评价人和被评人必须是同一人');

    // 问卷模板：优先用传入的，否则按关系类型取批次默认模板
    const surveyId =
      cycle.version >= 2
        ? cycle.templateSurveyId
        : (toIdOrNull(data?.surveyId) ??
          (relationType === 'self'
            ? cycle.selfSurveyId
            : relationType === 'leader'
              ? cycle.leaderSurveyId
              : cycle.peerSurveyId));
    if (!surveyId)
      throw new BadRequestException(
        '未指定问卷模板，且批次未绑定该类型的默认模板',
      );

    const count =
      cycle.version >= 2
        ? await this.prisma.evalCycleParticipant.count({
            where: { cycleId, contactId: { in: [rater, ratee] } },
          })
        : await this.prisma.contact.count({
            where: { id: { in: [rater, ratee] } },
          });
    if (count !== new Set([rater, ratee]).size)
      throw new BadRequestException('评价人或被评人不存在');

    try {
      return await this.prisma.evalRelation.create({
        data: {
          cycleId,
          raterContactId: rater,
          rateeContactId: ratee,
          relationType,
          surveyId,
          source: 'manual',
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          '该评价关系已存在（同一批次内评价人+被评人唯一）',
        );
      }
      throw e;
    }
  }

  async deleteRelation(relationId: number) {
    const rel = await this.prisma.evalRelation.findUnique({
      where: { id: relationId },
    });
    if (!rel) throw new NotFoundException('评价关系不存在');
    const cycle = await this.getCycle(rel.cycleId);
    if (cycle.status !== 'draft')
      throw new BadRequestException('只有草稿批次可以删除评价关系');
    if (rel.responseId)
      throw new BadRequestException('该关系已有人提交答卷，不能删除');
    await this.prisma.evalRelation.delete({ where: { id: relationId } });
    return { ok: true };
  }

  async exemptRelation(relationId: number, reason: string, adminId: number) {
    const relation = await this.prisma.evalRelation.findUnique({
      where: { id: relationId },
    });
    if (!relation) throw new NotFoundException('评价关系不存在');
    const cycle = await this.getCycle(relation.cycleId);
    if (!['draft', 'published', 'closed'].includes(cycle.status))
      throw new BadRequestException('当前批次状态不能登记豁免');
    if (relation.responseId)
      throw new BadRequestException('已有答卷的关系不能豁免');
    const text = String(reason || '').trim();
    if (!text) throw new BadRequestException('请填写豁免原因');
    const updated = await this.prisma.evalRelation.update({
      where: { id: relationId },
      data: { status: 'exempt', exceptionReason: text },
    });
    await this.writeAudit(
      relation.cycleId,
      adminId,
      'exempt_relation',
      'relation',
      relationId,
      relation,
      updated,
      text,
    );
    return updated;
  }

  // ── 生命周期、进度与结果 ──

  async publishCycle(cycleId: number, adminId: number) {
    const cycle = await this.requireDraftCycle(cycleId);
    if (!cycle.templateSurveyId)
      throw new BadRequestException('请先选择统一环评模板');
    if (!cycle.startAt || !cycle.endAt || cycle.startAt >= cycle.endAt)
      throw new BadRequestException('请设置合法的开始和截止时间');
    const templateRow = await this.getTemplate(cycle.templateSurveyId);
    const template = this.parseTemplate(templateRow.schemaJson);
    if (!template.questions.length)
      throw new BadRequestException('模板至少需要一道题目');
    const participantCount = await this.prisma.evalCycleParticipant.count({
      where: { cycleId },
    });
    if (!participantCount) throw new BadRequestException('请先确认参评人员');
    const relationCount = await this.prisma.evalRelation.count({
      where: { cycleId, status: { not: 'exempt' } },
    });
    if (!relationCount) throw new BadRequestException('请先生成或配置评价关系');
    const review = await this.getV2ReviewList(cycleId);
    if (review.summary.anomaly)
      throw new BadRequestException(
        `还有 ${review.summary.anomaly} 名参评人员存在关系异常，请先处理或豁免`,
      );
    const updated = await this.prisma.evalCycle.update({
      where: { id: cycleId },
      data: {
        status: 'published',
        templateSnapshotJson: template as unknown as Prisma.InputJsonValue,
      },
    });
    await this.writeAudit(
      cycleId,
      adminId,
      'publish_cycle',
      'cycle',
      cycleId,
      cycle,
      updated,
    );
    return updated;
  }

  async closeCycle(cycleId: number, adminId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.status !== 'published')
      throw new BadRequestException('只有已发布批次可以截止');
    const updated = await this.prisma.evalCycle.update({
      where: { id: cycleId },
      data: { status: 'closed', closedAt: new Date() },
    });
    await this.writeAudit(
      cycleId,
      adminId,
      'close_cycle',
      'cycle',
      cycleId,
      cycle,
      updated,
    );
    return updated;
  }

  async reopenCycle(cycleId: number, endAtValue: unknown, adminId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.status !== 'closed')
      throw new BadRequestException('只有已截止批次可以重新开放');
    const endAt = toDateOrNull(endAtValue);
    if (!endAt || endAt <= new Date())
      throw new BadRequestException('新的截止时间必须晚于当前时间');
    const updated = await this.prisma.evalCycle.update({
      where: { id: cycleId },
      data: { status: 'published', endAt, closedAt: null },
    });
    await this.writeAudit(
      cycleId,
      adminId,
      'reopen_cycle',
      'cycle',
      cycleId,
      cycle,
      updated,
    );
    return updated;
  }

  async lockCycle(cycleId: number, adminId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.status !== 'closed')
      throw new BadRequestException('只有已截止批次可以锁定结果');
    const participants = await this.prisma.evalCycleParticipant.findMany({
      where: { cycleId },
    });
    const lockedAt = new Date();
    for (const participant of participants)
      await this.recalculateEmployee(
        cycleId,
        participant.contactId,
        true,
        lockedAt,
      );
    const updated = await this.prisma.evalCycle.update({
      where: { id: cycleId },
      data: { status: 'locked', lockedAt, lockedBy: adminId },
    });
    await this.writeAudit(
      cycleId,
      adminId,
      'lock_cycle',
      'cycle',
      cycleId,
      cycle,
      updated,
    );
    return updated;
  }

  async archiveCycle(cycleId: number, adminId: number) {
    const cycle = await this.getCycle(cycleId);
    if (cycle.status !== 'locked')
      throw new BadRequestException('只有已锁定批次可以归档');
    const updated = await this.prisma.evalCycle.update({
      where: { id: cycleId },
      data: { status: 'archived', archivedAt: new Date() },
    });
    await this.writeAudit(
      cycleId,
      adminId,
      'archive_cycle',
      'cycle',
      cycleId,
      cycle,
      updated,
    );
    return updated;
  }

  async getOverview(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    const [participants, relations] = await Promise.all([
      this.prisma.evalCycleParticipant.findMany({ where: { cycleId } }),
      this.prisma.evalRelation.findMany({ where: { cycleId } }),
    ]);
    const activeRelations = relations.filter(
      (relation) => relation.status !== 'exempt',
    );
    const submittedRelations = activeRelations.filter(
      (relation) => relation.status === 'submitted' && relation.responseId,
    );
    const byGroup = new Map<
      string,
      {
        participantIds: Set<number>;
        relationIds: Set<number>;
        submittedIds: Set<number>;
      }
    >();
    const groupByContact = new Map(
      participants.map((participant) => [
        participant.contactId,
        participant.groupName,
      ]),
    );
    for (const participant of participants) {
      if (!byGroup.has(participant.groupName))
        byGroup.set(participant.groupName, {
          participantIds: new Set(),
          relationIds: new Set(),
          submittedIds: new Set(),
        });
      byGroup
        .get(participant.groupName)!
        .participantIds.add(participant.contactId);
    }
    for (const relation of activeRelations) {
      const group = groupByContact.get(relation.rateeContactId) || '未分组';
      if (!byGroup.has(group))
        byGroup.set(group, {
          participantIds: new Set(),
          relationIds: new Set(),
          submittedIds: new Set(),
        });
      byGroup.get(group)!.relationIds.add(relation.id);
      if (relation.status === 'submitted' && relation.responseId)
        byGroup.get(group)!.submittedIds.add(relation.id);
    }
    const completedRatees = participants.filter((participant) => {
      const expected = activeRelations.filter(
        (relation) => relation.rateeContactId === participant.contactId,
      ).length;
      const received = submittedRelations.filter(
        (relation) => relation.rateeContactId === participant.contactId,
      ).length;
      return expected > 0 && received >= expected;
    }).length;
    return {
      cycle,
      participantCount: participants.length,
      completedRateeCount: completedRatees,
      totalTasks: activeRelations.length,
      submittedTasks: submittedRelations.length,
      completionRate: activeRelations.length
        ? submittedRelations.length / activeRelations.length
        : 0,
      specialCount: participants.filter(
        (participant) => participant.mode === 'special',
      ).length,
      groups: Array.from(byGroup, ([groupName, value]) => ({
        groupName,
        participantCount: value.participantIds.size,
        totalTasks: value.relationIds.size,
        submittedTasks: value.submittedIds.size,
        completionRate: value.relationIds.size
          ? value.submittedIds.size / value.relationIds.size
          : 0,
      })),
    };
  }

  async listResults(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    const participants = await this.prisma.evalCycleParticipant.findMany({
      where: { cycleId },
      include: { groupSnapshots: true },
      orderBy: [{ groupName: 'asc' }, { nameSnapshot: 'asc' }],
    });
    if (!['locked', 'archived'].includes(cycle.status)) {
      for (const participant of participants)
        await this.recalculateEmployee(cycleId, participant.contactId, false);
    }
    const results = await this.prisma.evalEmployeeResult.findMany({
      where: { cycleId },
    });
    const resultMap = new Map(
      results.map((result) => [result.rateeContactId, result]),
    );
    return participants.map((participant) => ({
      ...participant,
      result: resultMap.get(participant.contactId) || null,
    }));
  }

  async getRaterProgress(cycleId: number, contactId: number) {
    await this.getCycle(cycleId);
    const participant = await this.prisma.evalCycleParticipant.findUnique({
      where: { cycleId_contactId: { cycleId, contactId } },
      include: { groupSnapshots: true },
    });
    if (!participant) throw new NotFoundException('该员工不在本批次参评范围');

    const relations = await this.prisma.evalRelation.findMany({
      where: { cycleId, raterContactId: contactId },
      orderBy: [{ relationType: 'asc' }, { id: 'asc' }],
    });
    const rateeIds = Array.from(
      new Set(relations.map((relation) => relation.rateeContactId)),
    );
    const [rateeParticipants, fallbackContacts] = await Promise.all([
      this.prisma.evalCycleParticipant.findMany({
        where: { cycleId, contactId: { in: rateeIds } },
        include: { groupSnapshots: true },
      }),
      this.prisma.contact.findMany({
        where: { id: { in: rateeIds } },
        select: { id: true, name: true },
      }),
    ]);
    const participantOf = new Map(
      rateeParticipants.map((value) => [value.contactId, value]),
    );
    const fallbackNameOf = new Map(
      fallbackContacts.map((value) => [value.id, value.name]),
    );

    const itemOf = (relation: (typeof relations)[number]) => {
      const ratee = participantOf.get(relation.rateeContactId);
      let sharedGroups: Array<{
        departmentId: number | null;
        name: string;
        path: string;
      }> = [];
      if (
        relation.source === 'auto' &&
        relation.relationType === 'peer' &&
        ratee
      ) {
        if (
          participant.groupSnapshots.length &&
          ratee.groupSnapshots.length
        ) {
          sharedGroups = findSharedEnabledGroups(
            participant.groupSnapshots,
            ratee.groupSnapshots,
          );
        } else if (participant.groupKey === ratee.groupKey) {
          sharedGroups = [
            {
              departmentId: null,
              name: participant.groupName,
              path: participant.groupName,
            },
          ];
        }
      }
      return {
        relationId: relation.id,
        contactId: relation.rateeContactId,
        name:
          ratee?.nameSnapshot ||
          fallbackNameOf.get(relation.rateeContactId) ||
          `#${relation.rateeContactId}`,
        source: relation.source,
        sharedGroups,
      };
    };

    const definitions = [
      { type: 'self', label: '自评' },
      { type: 'peer', label: '同事互评' },
      { type: 'leader', label: '领导评价' },
    ];
    const groups = definitions.flatMap((definition) => {
      const rows = relations.filter(
        (relation) => relation.relationType === definition.type,
      );
      if (definition.type === 'leader' && !rows.length) return [];
      const completed = rows
        .filter(
          (relation) =>
            relation.status === 'submitted' && !!relation.responseId,
        )
        .map(itemOf);
      const pending = rows
        .filter(
          (relation) =>
            relation.status !== 'submitted' || !relation.responseId,
        )
        .map(itemOf);
      return [
        {
          ...definition,
          total: rows.length,
          completedCount: completed.length,
          pendingCount: pending.length,
          completionRate: rows.length ? completed.length / rows.length : null,
          completed,
          pending,
        },
      ];
    });
    const completed = groups.reduce(
      (total, group) => total + group.completedCount,
      0,
    );
    const total = relations.length;
    return {
      participant: {
        contactId: participant.contactId,
        name: participant.nameSnapshot,
      },
      summary: {
        total,
        completed,
        pending: total - completed,
        completionRate: total ? completed / total : null,
      },
      groups,
    };
  }

  async getEmployeeReport(cycleId: number, contactId: number) {
    const cycle = await this.getCycle(cycleId);
    const participant = await this.prisma.evalCycleParticipant.findUnique({
      where: { cycleId_contactId: { cycleId, contactId } },
    });
    if (!participant) throw new NotFoundException('该员工不在本批次参评范围');
    if (!['locked', 'archived'].includes(cycle.status))
      await this.recalculateEmployee(cycleId, contactId, false);
    const result = await this.prisma.evalEmployeeResult.findUnique({
      where: { cycleId_rateeContactId: { cycleId, rateeContactId: contactId } },
    });
    const relations = await this.prisma.evalRelation.findMany({
      where: { cycleId, rateeContactId: contactId, responseId: { not: null } },
    });
    const responseIds = relations
      .map((relation) => relation.responseId)
      .filter((id): id is number => !!id);
    const responses = await this.prisma.surveyResponse.findMany({
      where: { id: { in: responseIds }, validStatus: 'valid' },
    });
    const relationMap = new Map(
      relations.map((relation) => [relation.responseId, relation]),
    );
    const template = this.parseTemplate(
      cycle.templateSnapshotJson ||
        (cycle.templateSurveyId
          ? (await this.getTemplate(cycle.templateSurveyId)).schemaJson
          : null),
    );
    const questionMap = new Map(
      template.questions.map((question) => [question.id, question]),
    );
    const dimensionMap = new Map(
      template.dimensions.map((dimension) => [dimension.id, dimension.name]),
    );
    const cases = responses.flatMap((response) =>
      Object.entries(response.answersJson as Record<string, unknown>).flatMap(
        ([questionId, value]) => {
          const question = questionMap.get(questionId);
          if (question?.type !== 'evaluation_score') return [];
          if (!value || typeof value !== 'object') return [];
          const answer = value as EvalAnswer;
          if (!String(answer.caseText || '').trim()) return [];
          return [
            {
              questionId,
              questionLabel: question.label,
              score: answer.score,
              caseText: String(answer.caseText),
              relationType: relationMap.get(response.id)?.relationType,
            },
          ];
        },
      ),
    );
    const textFeedback = responses.flatMap((response) =>
      template.questions.flatMap((question) => {
        if (question.type !== 'evaluation_text') return [];
        const value = (response.answersJson as Record<string, unknown>)[
          question.id
        ];
        if (typeof value !== 'string' || !value.trim()) return [];
        return [
          {
            questionId: question.id,
            questionLabel: question.label,
            dimensionId: question.dimensionId,
            dimensionName: dimensionMap.get(question.dimensionId) || '',
            relationType: relationMap.get(response.id)?.relationType,
            text: value.trim(),
          },
        ];
      }),
    );
    return { cycle, participant, result, cases, textFeedback };
  }

  async listRawResponses(cycleId: number) {
    const relations = await this.listRelations(cycleId);
    const responseIds = relations
      .map((relation) => relation.responseId)
      .filter((id): id is number => !!id);
    const relationIds = relations.map((relation) => relation.id);
    const responses = await this.prisma.surveyResponse.findMany({
      where: {
        OR: [
          { evalRelationId: { in: relationIds } },
          { id: { in: responseIds } },
        ],
      },
      orderBy: { submittedAt: 'desc' },
    });
    const relationByResponse = new Map(
      relations.map((relation) => [relation.responseId, relation]),
    );
    const relationById = new Map(
      relations.map((relation) => [relation.id, relation]),
    );
    return responses.map((response) => ({
      ...response,
      relation: response.evalRelationId
        ? relationById.get(response.evalRelationId)
        : relationByResponse.get(response.id),
    }));
  }

  async invalidateResponse(
    responseId: number,
    reasonValue: string,
    adminId: number,
  ) {
    const response = await this.prisma.surveyResponse.findUnique({
      where: { id: responseId },
    });
    if (!response?.evalRelationId)
      throw new NotFoundException('环评答卷不存在');
    const relation = await this.prisma.evalRelation.findUnique({
      where: { id: response.evalRelationId },
    });
    if (!relation) throw new NotFoundException('评价关系不存在');
    const cycle = await this.getCycle(relation.cycleId);
    if (['locked', 'archived'].includes(cycle.status))
      throw new BadRequestException('结果锁定后不能作废答卷');
    const reason = String(reasonValue || '').trim();
    if (!reason) throw new BadRequestException('请填写作废原因');
    await this.prisma.$transaction(async (tx) => {
      await tx.surveyResponse.update({
        where: { id: responseId },
        data: {
          validStatus: 'invalid',
          invalidReason: reason,
          invalidatedAt: new Date(),
          invalidatedBy: adminId,
        },
      });
      if (relation.responseId === responseId)
        await tx.evalRelation.update({
          where: { id: relation.id },
          data: { responseId: null, status: 'pending' },
        });
    });
    await this.writeAudit(
      relation.cycleId,
      adminId,
      'invalidate_response',
      'response',
      responseId,
      response,
      { validStatus: 'invalid' },
      reason,
    );
    await this.recalculateEmployee(
      relation.cycleId,
      relation.rateeContactId,
      false,
    );
    return { ok: true };
  }

  async restoreResponse(responseId: number, adminId: number) {
    const response = await this.prisma.surveyResponse.findUnique({
      where: { id: responseId },
    });
    if (!response?.evalRelationId)
      throw new NotFoundException('环评答卷不存在');
    const relation = await this.prisma.evalRelation.findUnique({
      where: { id: response.evalRelationId },
    });
    if (!relation) throw new NotFoundException('评价关系不存在');
    const cycle = await this.getCycle(relation.cycleId);
    if (['locked', 'archived'].includes(cycle.status))
      throw new BadRequestException('结果锁定后不能恢复答卷');
    if (relation.responseId && relation.responseId !== responseId)
      throw new ConflictException('该关系已经有新的有效答卷，不能恢复旧答卷');
    await this.prisma.$transaction(async (tx) => {
      await tx.surveyResponse.update({
        where: { id: responseId },
        data: {
          validStatus: 'valid',
          restoredAt: new Date(),
          restoredBy: adminId,
        },
      });
      await tx.evalRelation.update({
        where: { id: relation.id },
        data: { responseId, status: 'submitted' },
      });
    });
    await this.writeAudit(
      relation.cycleId,
      adminId,
      'restore_response',
      'response',
      responseId,
      response,
      { validStatus: 'valid' },
    );
    await this.recalculateEmployee(
      relation.cycleId,
      relation.rateeContactId,
      false,
    );
    return { ok: true };
  }

  private async recalculateEmployee(
    cycleId: number,
    rateeContactId: number,
    final: boolean,
    lockedAt?: Date,
  ) {
    const cycle = await this.getCycle(cycleId);
    const snapshot =
      cycle.templateSnapshotJson ||
      (cycle.templateSurveyId
        ? (await this.getTemplate(cycle.templateSurveyId)).schemaJson
        : null);
    const template = this.parseTemplate(snapshot);
    const relations = await this.prisma.evalRelation.findMany({
      where: { cycleId, rateeContactId, status: { not: 'exempt' } },
    });
    const responseIds = relations
      .map((relation) => relation.responseId)
      .filter((id): id is number => !!id);
    const responses = await this.prisma.surveyResponse.findMany({
      where: { id: { in: responseIds }, validStatus: 'valid' },
    });
    const responseMap = new Map(
      responses.map((response) => [response.id, response]),
    );
    const scoringResponses: EvalResponseForScoring[] = relations.flatMap(
      (relation) => {
        const response = relation.responseId
          ? responseMap.get(relation.responseId)
          : undefined;
        return response
          ? [
              {
                relationType:
                  relation.relationType as EvalResponseForScoring['relationType'],
                answers: response.answersJson as Record<string, unknown>,
              },
            ]
          : [];
      },
    );
    const score = calculateEmployeeScore(template, scoringResponses);
    return this.prisma.evalEmployeeResult.upsert({
      where: { cycleId_rateeContactId: { cycleId, rateeContactId } },
      create: {
        cycleId,
        rateeContactId,
        resultStatus: final ? 'final' : 'provisional',
        totalScore: score.totalScore,
        dimensionScoresJson:
          score.dimensionScores as unknown as Prisma.InputJsonValue,
        questionScoresJson:
          score.questionScores as unknown as Prisma.InputJsonValue,
        receivedCount: scoringResponses.length,
        expectedCount: relations.length,
        templateVersion: template.version,
        calculatedAt: new Date(),
        lockedAt: final ? lockedAt || new Date() : null,
      },
      update: {
        resultStatus: final ? 'final' : 'provisional',
        totalScore: score.totalScore,
        dimensionScoresJson:
          score.dimensionScores as unknown as Prisma.InputJsonValue,
        questionScoresJson:
          score.questionScores as unknown as Prisma.InputJsonValue,
        receivedCount: scoringResponses.length,
        expectedCount: relations.length,
        templateVersion: template.version,
        calculatedAt: new Date(),
        ...(final ? { lockedAt: lockedAt || new Date() } : {}),
      },
    });
  }

  private async writeAudit(
    cycleId: number,
    adminId: number,
    action: string,
    targetType: string,
    targetId: string | number | null,
    before: unknown,
    after: unknown,
    reason?: string,
  ) {
    return this.prisma.evalAuditLog.create({
      data: {
        cycleId,
        adminId,
        action,
        targetType,
        targetId: targetId === null ? null : String(targetId),
        beforeJson: before === undefined ? undefined : toJsonInput(before),
        afterJson: after === undefined ? undefined : toJsonInput(after),
        reason: reason || null,
      },
    });
  }

  // ── 填写端：待我填写 + 逐份提交 ──

  async listMyTasks(fillUser: EvalFillUser) {
    const relations = await this.prisma.evalRelation.findMany({
      where: {
        raterContactId: fillUser.sub,
        status: { not: 'exempt' },
        cycle: { status: 'published' },
      },
      include: { cycle: true },
      orderBy: [{ cycleId: 'desc' }, { id: 'asc' }],
    });
    const now = new Date();
    const available = relations.filter(
      (relation) =>
        relation.cycle.version < 2 ||
        ((!relation.cycle.startAt || relation.cycle.startAt <= now) &&
          (!relation.cycle.endAt || relation.cycle.endAt >= now)),
    );
    const rateeIds = Array.from(
      new Set(available.map((r) => r.rateeContactId)),
    );
    const surveyIds = Array.from(new Set(available.map((r) => r.surveyId)));
    const [ratees, surveys, participants] = await Promise.all([
      this.prisma.contact.findMany({ where: { id: { in: rateeIds } } }),
      this.prisma.survey.findMany({
        where: { id: { in: surveyIds } },
        select: { id: true, title: true },
      }),
      this.prisma.evalCycleParticipant.findMany({
        where: {
          cycleId: { in: Array.from(new Set(available.map((r) => r.cycleId))) },
          contactId: { in: rateeIds },
        },
      }),
    ]);
    const rateeName = new Map(ratees.map((c) => [c.id, c.name]));
    for (const participant of participants)
      rateeName.set(participant.contactId, participant.nameSnapshot);
    const surveyTitle = new Map(surveys.map((s) => [s.id, s.title]));

    const byCycle = new Map<number, any>();
    for (const r of available) {
      if (!byCycle.has(r.cycleId)) {
        byCycle.set(r.cycleId, {
          cycleId: r.cycleId,
          cycleName: r.cycle.name,
          cycleStatus: r.cycle.status,
          tasks: [],
        });
      }
      byCycle.get(r.cycleId).tasks.push({
        relationId: r.id,
        type: r.relationType,
        rateeContactId: r.rateeContactId,
        rateeName:
          r.relationType === 'self'
            ? '本人（自评）'
            : (rateeName.get(r.rateeContactId) ?? `#${r.rateeContactId}`),
        surveyId: r.surveyId,
        surveyTitle: surveyTitle.get(r.surveyId) ?? '',
        done: !!r.responseId,
      });
    }
    return Array.from(byCycle.values());
  }

  async getTask(relationId: number, fillUser: EvalFillUser) {
    const rel = await this.prisma.evalRelation.findUnique({
      where: { id: relationId },
      include: { cycle: true },
    });
    if (!rel) throw new NotFoundException('填写任务不存在');
    if (rel.raterContactId !== fillUser.sub)
      throw new ForbiddenException('这不是分配给你的填写任务');
    this.assertCycleFillable(rel.cycle);
    if (rel.status === 'exempt') throw new BadRequestException('该任务已豁免');
    const survey = await this.prisma.survey.findUnique({
      where: { id: rel.surveyId },
    });
    if (!survey) throw new NotFoundException('问卷模板不存在');
    const participant =
      rel.relationType === 'self'
        ? null
        : await this.prisma.evalCycleParticipant.findUnique({
            where: {
              cycleId_contactId: {
                cycleId: rel.cycleId,
                contactId: rel.rateeContactId,
              },
            },
          });
    const ratee = participant
      ? null
      : rel.relationType === 'self'
        ? null
        : await this.prisma.contact.findUnique({
            where: { id: rel.rateeContactId },
          });
    return {
      relationId: rel.id,
      type: rel.relationType,
      done: !!rel.responseId,
      rateeName:
        rel.relationType === 'self'
          ? '本人（自评）'
          : (participant?.nameSnapshot ??
            ratee?.name ??
            `#${rel.rateeContactId}`),
      survey: {
        id: survey.id,
        title: survey.title,
        schemaJson:
          rel.cycle.version >= 2
            ? rel.cycle.templateSnapshotJson || survey.schemaJson
            : survey.schemaJson,
      },
    };
  }

  async submitTask(
    relationId: number,
    answersJson: Record<string, unknown>,
    fillUser: EvalFillUser,
    startedAtValue?: unknown,
  ) {
    const rel = await this.prisma.evalRelation.findUnique({
      where: { id: relationId },
      include: { cycle: true },
    });
    if (!rel) throw new NotFoundException('填写任务不存在');
    if (rel.raterContactId !== fillUser.sub)
      throw new ForbiddenException('这不是分配给你的填写任务');
    this.assertCycleFillable(rel.cycle);
    if (rel.status === 'exempt') throw new BadRequestException('该任务已豁免');
    if (rel.responseId)
      throw new ConflictException('该任务你已提交，无需重复填写');

    let validatedAnswers = answersJson;
    if (rel.cycle.version >= 2) {
      const survey = await this.prisma.survey.findUnique({
        where: { id: rel.surveyId },
      });
      if (!survey) throw new NotFoundException('环评模板不存在');
      const template = this.parseTemplate(
        rel.cycle.templateSnapshotJson || survey.schemaJson,
      );
      validatedAnswers = this.validateEvalAnswers(template, answersJson);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const response = await tx.surveyResponse.create({
        data: {
          surveyId: rel.surveyId,
          wecomUserid: fillUser.wecomUserid,
          rateeContactId: rel.rateeContactId,
          evalRelationId: rel.id,
          startedAt: toDateOrNull(startedAtValue),
          answersJson: validatedAnswers as Prisma.InputJsonValue,
        },
      });
      const updated = await tx.evalRelation.updateMany({
        where: { id: rel.id, responseId: null, status: 'pending' },
        data: { responseId: response.id, status: 'submitted' },
      });
      if (updated.count !== 1)
        throw new ConflictException('该任务已经提交或状态已变化，请刷新后重试');
      return { ok: true, responseId: response.id };
    });
    if (rel.cycle.version >= 2)
      await this.recalculateEmployee(rel.cycleId, rel.rateeContactId, false);
    return result;
  }

  private assertCycleFillable(cycle: {
    status: string;
    version: number;
    startAt: Date | null;
    endAt: Date | null;
  }) {
    if (cycle.status !== 'published')
      throw new BadRequestException('当前批次未开放填写');
    if (cycle.version < 2) return;
    const now = new Date();
    if (cycle.startAt && now < cycle.startAt)
      throw new BadRequestException('环评尚未开始');
    if (cycle.endAt && now > cycle.endAt)
      throw new BadRequestException('环评已经截止');
  }

  private validateEvalAnswers(
    template: EvalTemplate,
    answers: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers))
      throw new BadRequestException('答卷格式不正确');
    const questionIds = new Set(
      template.questions.map((question) => question.id),
    );
    const unknownQuestionId = Object.keys(answers).find(
      (questionId) => !questionIds.has(questionId),
    );
    if (unknownQuestionId)
      throw new BadRequestException(`答卷包含无效题目：${unknownQuestionId}`);
    const normalized: Record<string, unknown> = {};
    for (const question of template.questions) {
      const value = answers[question.id];
      if (value === undefined || value === null || value === '') {
        if (question.required)
          throw new BadRequestException(`请填写：${question.label}`);
        continue;
      }
      if (question.type === 'evaluation_text') {
        if (typeof value !== 'string')
          throw new BadRequestException(`${question.label} 的答案格式不正确`);
        const text = value.trim();
        if (!text) {
          if (question.required)
            throw new BadRequestException(`请填写：${question.label}`);
          continue;
        }
        if (text.length > question.maxLength)
          throw new BadRequestException(
            `${question.label} 最多填写 ${question.maxLength} 个字符`,
          );
        normalized[question.id] = text;
        continue;
      }
      if (typeof value !== 'object')
        throw new BadRequestException(`${question.label} 的答案格式不正确`);
      const answer = value as EvalAnswer;
      const score = Number(answer.score);
      if (!Number.isInteger(score) || score < 0 || score > 5)
        throw new BadRequestException(`${question.label} 的评分范围为 0~5`);
      if (
        question.caseRequiredScores.includes(score) &&
        !String(answer.caseText || '').trim()
      ) {
        throw new BadRequestException(`请填写“${question.label}”的案例说明`);
      }
      normalized[question.id] = {
        score,
        caseText: String(answer.caseText || '').trim(),
      };
    }
    return normalized;
  }

  // ── 结果导出（Excel，三分表：自评/他评/领导评价，答案按题拆列）──

  async exportCycle(cycleId: number): Promise<ExcelJS.Buffer> {
    const cycle = await this.getCycle(cycleId);
    if (cycle.version >= 2) return this.exportV2Cycle(cycleId);
    const rows = await this.listRelations(cycleId);
    const responseIds = rows
      .map((r) => r.responseId)
      .filter((x): x is number => !!x);
    const responses = await this.prisma.surveyResponse.findMany({
      where: { id: { in: responseIds } },
    });
    const answerOf = new Map(
      responses.map((r) => [r.id, r.answersJson as Record<string, unknown>]),
    );
    const submittedAt = new Map(responses.map((r) => [r.id, r.submittedAt]));

    // 三份模板的题目（描述题不占列）
    const templateIds = [
      cycle.selfSurveyId,
      cycle.peerSurveyId,
      cycle.leaderSurveyId,
    ].filter((x): x is number => !!x);
    const surveys = await this.prisma.survey.findMany({
      where: { id: { in: templateIds } },
    });
    const questionsOf = (surveyId: number | null) => {
      if (!surveyId) return [];
      const s = surveys.find((x) => x.id === surveyId);
      const qs = ((s?.schemaJson as any)?.questions || []) as Array<{
        id: string;
        type: string;
        label: string;
      }>;
      return qs.filter((q) => q.type !== 'description');
    };

    const wb = new ExcelJS.Workbook();
    const sheets: Array<{
      type: string;
      label: string;
      surveyId: number | null;
    }> = [
      { type: 'self', label: '自评', surveyId: cycle.selfSurveyId },
      { type: 'peer', label: '他评', surveyId: cycle.peerSurveyId },
      { type: 'leader', label: '领导评价', surveyId: cycle.leaderSurveyId },
    ];

    for (const sheet of sheets) {
      const ws = wb.addWorksheet(sheet.label);
      const questions = questionsOf(sheet.surveyId);
      ws.columns = [
        { header: '批次', key: 'cycle', width: 20 },
        { header: '关系类型', key: 'type', width: 12 },
        { header: '评价人', key: 'rater', width: 14 },
        { header: '被评人', key: 'ratee', width: 14 },
        { header: '是否提交', key: 'submitted', width: 10 },
        { header: '提交时间', key: 'time', width: 20 },
        ...questions.map((q, i) => ({
          header: `Q${i + 1} ${q.label}`,
          key: `q_${q.id}`,
          width: 24,
        })),
      ];
      ws.getRow(1).font = { bold: true };

      for (const r of rows.filter((x) => x.relationType === sheet.type)) {
        const ans = r.responseId ? (answerOf.get(r.responseId) ?? {}) : {};
        const row: Record<string, unknown> = {
          cycle: cycle.name,
          type: sheet.label,
          rater: r.raterName,
          ratee: r.rateeName,
          submitted: r.done ? '已提交' : '未提交',
          time: r.responseId
            ? new Date(submittedAt.get(r.responseId)!).toLocaleString('zh-CN')
            : '',
        };
        for (const q of questions) row[`q_${q.id}`] = formatAnswer(ans[q.id]);
        ws.addRow(row);
      }
    }

    return wb.xlsx.writeBuffer();
  }

  private async exportV2Cycle(cycleId: number): Promise<ExcelJS.Buffer> {
    const cycle = await this.getCycle(cycleId);
    const template = this.parseTemplate(
      cycle.templateSnapshotJson ||
        (cycle.templateSurveyId
          ? (await this.getTemplate(cycle.templateSurveyId)).schemaJson
          : null),
    );
    const [resultRows, rawRows] = await Promise.all([
      this.listResults(cycleId),
      this.listRawResponses(cycleId),
    ]);
    const workbook = new ExcelJS.Workbook();
    const scoreQuestions = template.questions.filter(
      (question) => question.type === 'evaluation_score',
    );
    const textQuestions = template.questions.filter(
      (question) => question.type === 'evaluation_text',
    );

    const summarySheet = workbook.addWorksheet('员工汇总');
    summarySheet.columns = [
      { header: '员工', key: 'name', width: 16 },
      { header: '工号', key: 'jobNo', width: 14 },
      { header: '部门', key: 'department', width: 18 },
      { header: '评价小组', key: 'group', width: 18 },
      { header: '已收/应收', key: 'progress', width: 12 },
      { header: '总分', key: 'total', width: 12 },
      { header: '结果状态', key: 'status', width: 12 },
      ...template.dimensions.map((dimension) => ({
        header: dimension.name,
        key: `dimension_${dimension.id}`,
        width: 14,
      })),
    ];
    summarySheet.getRow(1).font = { bold: true };
    for (const row of resultRows) {
      const result = row.result as any;
      const values: Record<string, unknown> = {
        name: row.nameSnapshot,
        jobNo: row.jobNoSnapshot || '',
        department: row.departmentSnapshot || '',
        group: row.groupName,
        progress: `${result?.receivedCount || 0}/${result?.expectedCount || 0}`,
        total:
          result?.totalScore === null || result?.totalScore === undefined
            ? ''
            : Number(result.totalScore).toFixed(2),
        status: result?.resultStatus === 'final' ? '最终' : '暂定',
      };
      for (const dimension of (result?.dimensionScoresJson || []) as any[]) {
        values[`dimension_${dimension.dimensionId}`] =
          dimension.score === null ? '' : Number(dimension.score).toFixed(2);
      }
      summarySheet.addRow(values);
    }

    const departmentSheet = workbook.addWorksheet('部门数据');
    departmentSheet.columns = [
      { header: '部门层级', key: 'level', width: 12 },
      { header: '部门名称', key: 'name', width: 20 },
      { header: '完整部门路径', key: 'path', width: 42 },
      { header: '部门人数', key: 'participantCount', width: 12 },
      { header: '已评分人数', key: 'scoredParticipantCount', width: 14 },
      ...template.dimensions.map((dimension) => ({
        header: `${dimension.name}平均分`,
        key: `dimension_${dimension.id}`,
        width: 16,
      })),
      { header: '总平均分', key: 'totalAverage', width: 14 },
    ];
    departmentSheet.getRow(1).font = { bold: true };
    const departmentRows = buildDepartmentSummaryRows(
      resultRows,
      template.dimensions.map((dimension) => dimension.id),
    );
    for (const department of departmentRows) {
      const values: Record<string, unknown> = {
        level: department.level,
        name: department.name,
        path: department.path,
        participantCount: department.participantCount,
        scoredParticipantCount: department.scoredParticipantCount,
        totalAverage:
          department.totalAverage === null
            ? ''
            : Number(department.totalAverage.toFixed(2)),
      };
      for (const dimension of template.dimensions) {
        const average = department.dimensionAverages[dimension.id];
        values[`dimension_${dimension.id}`] =
          average === null ? '' : Number(average.toFixed(2));
      }
      departmentSheet.addRow(values);
    }
    for (
      let columnIndex = 6;
      columnIndex <= departmentSheet.columnCount;
      columnIndex += 1
    )
      departmentSheet.getColumn(columnIndex).numFmt = '0.00';

    const questionSheet = workbook.addWorksheet('逐题得分');
    questionSheet.columns = [
      { header: '员工', key: 'name', width: 16 },
      { header: '评价小组', key: 'group', width: 18 },
      { header: '维度', key: 'dimension', width: 16 },
      { header: '题目', key: 'question', width: 32 },
      { header: '自评', key: 'self', width: 10 },
      { header: '他评平均', key: 'other', width: 12 },
      { header: '综合得分', key: 'score', width: 12 },
      { header: '有效答案数', key: 'count', width: 12 },
    ];
    questionSheet.getRow(1).font = { bold: true };
    const dimensionName = new Map(
      template.dimensions.map((dimension) => [dimension.id, dimension.name]),
    );
    for (const row of resultRows) {
      for (const question of ((row.result as any)?.questionScoresJson ||
        []) as any[]) {
        questionSheet.addRow({
          name: row.nameSnapshot,
          group: row.groupName,
          dimension: dimensionName.get(question.dimensionId) || '',
          question: question.label,
          self: displayScore(question.selfScore),
          other: displayScore(question.otherScore),
          score: displayScore(question.score),
          count: question.answerCount,
        });
      }
    }

    const rawSheet = workbook.addWorksheet('原始答卷');
    rawSheet.columns = [
      { header: '答卷编号', key: 'id', width: 12 },
      { header: '评价人', key: 'rater', width: 16 },
      { header: '被评人', key: 'ratee', width: 16 },
      { header: '关系', key: 'relationType', width: 12 },
      { header: '开始时间', key: 'startedAt', width: 22 },
      { header: '提交时间', key: 'submittedAt', width: 22 },
      { header: '有效状态', key: 'validStatus', width: 12 },
      ...template.questions.flatMap((question, index) =>
        question.type === 'evaluation_score'
          ? [
              {
                header: `Q${index + 1} ${question.label}（分值）`,
                key: `score_${question.id}`,
                width: 24,
              },
              {
                header: `Q${index + 1} ${question.label}（案例）`,
                key: `case_${question.id}`,
                width: 40,
              },
            ]
          : [
              {
                header: `Q${index + 1} ${question.label}（文字反馈）`,
                key: `text_${question.id}`,
                width: 60,
              },
            ],
      ),
    ];
    rawSheet.getRow(1).font = { bold: true };
    const caseSheet = workbook.addWorksheet('案例说明');
    caseSheet.columns = [
      { header: '被评人', key: 'ratee', width: 16 },
      { header: '评价关系', key: 'relationType', width: 12 },
      { header: '维度', key: 'dimension', width: 16 },
      { header: '题目', key: 'question', width: 32 },
      { header: '分值', key: 'score', width: 10 },
      { header: '案例', key: 'caseText', width: 60 },
    ];
    caseSheet.getRow(1).font = { bold: true };
    const feedbackSheet = workbook.addWorksheet('文字反馈');
    feedbackSheet.columns = [
      { header: '被评人', key: 'ratee', width: 16 },
      { header: '部门', key: 'department', width: 18 },
      { header: '评价关系', key: 'relationType', width: 12 },
      { header: '维度', key: 'dimension', width: 16 },
      { header: '题目', key: 'question', width: 32 },
      { header: '反馈内容', key: 'text', width: 60 },
    ];
    feedbackSheet.getRow(1).font = { bold: true };
    const participantByContact = new Map(
      resultRows.map((participant) => [participant.contactId, participant]),
    );
    for (const row of rawRows) {
      const answers = row.answersJson as Record<string, unknown>;
      const values: Record<string, unknown> = {
        id: row.id,
        rater: row.relation?.raterName || '',
        ratee: row.relation?.rateeName || '',
        relationType: relationLabel(row.relation?.relationType),
        startedAt: row.startedAt ? formatDateTime(row.startedAt) : '',
        submittedAt: formatDateTime(row.submittedAt),
        validStatus: row.validStatus === 'valid' ? '有效' : '已作废',
      };
      for (const question of scoreQuestions) {
        const answer = answers[question.id] as EvalAnswer | undefined;
        values[`score_${question.id}`] = answer?.score ?? '';
        values[`case_${question.id}`] = answer?.caseText || '';
        if (String(answer?.caseText || '').trim()) {
          caseSheet.addRow({
            ratee: row.relation?.rateeName || '',
            relationType: relationLabel(row.relation?.relationType),
            dimension: dimensionName.get(question.dimensionId) || '',
            question: question.label,
            score: answer?.score,
            caseText: answer?.caseText,
          });
        }
      }
      for (const question of textQuestions) {
        const answer = answers[question.id];
        const text = typeof answer === 'string' ? answer.trim() : '';
        values[`text_${question.id}`] = text;
        if (text) {
          const rateeContactId = row.relation?.rateeContactId;
          const participant = rateeContactId
            ? participantByContact.get(rateeContactId)
            : undefined;
          feedbackSheet.addRow({
            ratee: row.relation?.rateeName || '',
            department: participant?.departmentSnapshot || '',
            relationType: relationLabel(row.relation?.relationType),
            dimension: dimensionName.get(question.dimensionId) || '',
            question: question.label,
            text,
          });
        }
      }
      rawSheet.addRow(values);
    }

    for (const sheet of workbook.worksheets)
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return workbook.xlsx.writeBuffer();
  }
}

// 答案格式化：多选用"、"连接；"其他"选项显示为「其他：xxx」
function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(formatOne).join('、');
  return formatOne(v);
}
function formatOne(v: unknown): string {
  const s = String(v);
  return s.startsWith('__other__:')
    ? `其他：${s.slice('__other__:'.length)}`
    : s;
}

function toIdOrNull(v: any): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function uniquePositiveIds(values: unknown[]): number[] {
  return Array.from(
    new Set(
      values
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
}

function toDateOrNull(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new BadRequestException('日期时间格式不正确');
  return date;
}

function displayScore(value: unknown): string {
  return value === null || value === undefined ? '' : Number(value).toFixed(2);
}

function relationLabel(value: unknown): string {
  return (
    (
      { self: '自评', peer: '同事评价', leader: '领导评价' } as Record<
        string,
        string
      >
    )[String(value)] || String(value || '')
  );
}

function formatDateTime(value: Date | string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
