import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from './prisma.service';
import { normalizeContactPhone } from './organization.service';

type DepartmentImportRow = {
  row: number;
  code: string;
  name: string;
  parentCode: string | null;
  sortOrder: number;
  isActive: boolean;
};

type EmployeeImportRow = {
  row: number;
  name: string;
  phone: string;
  jobNo: string | null;
  position: string | null;
  email: string | null;
  tags: string | null;
  primaryDepartmentCode: string;
  primaryRoleName: string | null;
  isActive: boolean;
};

type SecondaryImportRow = {
  row: number;
  phone: string;
  departmentCode: string;
  roleName: string | null;
  defaultEvalEnabled: boolean;
};

type ParsedWorkbook = {
  departments: DepartmentImportRow[];
  employees: EmployeeImportRow[];
  secondaries: SecondaryImportRow[];
};

type DiffField = {
  field: string;
  label: string;
  before: string;
  after: string;
};

type ImportDiffItem = {
  id: string;
  category: 'create' | 'change' | 'inactive' | 'conflict' | 'unchanged';
  entityType: 'department' | 'contact';
  changeType: string;
  label: string;
  identity: string;
  sheet: string;
  row: number;
  fields: DiffField[];
  reason?: string;
  selectedByDefault: boolean;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const cell = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: unknown }>;
    };
    if (cell.text !== undefined) return String(cell.text).trim();
    if (cell.result !== undefined) return String(cell.result).trim();
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => String(part.text ?? '')).join('').trim();
    }
  }
  return String(value).trim();
}

function nullable(value: unknown): string | null {
  return text(value) || null;
}

function enabled(value: unknown, fallback = true): boolean {
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  if (['停用', '否', 'false', '0', '关闭', 'no'].includes(normalized)) return false;
  return true;
}

@Injectable()
export class OrganizationWorkbookService {
  constructor(private readonly prisma: PrismaService) {}

  async importWorkbook(file: Express.Multer.File, dryRun: boolean) {
    if (!file?.buffer?.length) throw new BadRequestException('请选择 Excel 文件');
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('组织架构仅支持 .xlsx 文件');
    }
    const parsed = await this.parseWorkbook(file.buffer);
    const preview = await this.validateWorkbook(parsed);
    if (dryRun) return preview;
    if (preview.errors.length) {
      throw new BadRequestException(
        `导入存在 ${preview.errors.length} 个阻断错误，请先修正后重新上传`,
      );
    }
    await this.applyWorkbook(parsed);
    return { ...preview, applied: true };
  }

  async previewWorkbook(file: Express.Multer.File) {
    this.assertWorkbookFile(file);
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const parsed = await this.parseWorkbook(file.buffer);
    return this.buildPreview(parsed, fileHash);
  }

  async applyWorkbookSelection(
    file: Express.Multer.File,
    input: { fileHash?: unknown; baselineHash?: unknown; selectedIds?: unknown },
  ) {
    this.assertWorkbookFile(file);
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    if (String(input.fileHash || '') !== fileHash) {
      throw new BadRequestException('导入文件已变化，请重新预览');
    }
    const parsed = await this.parseWorkbook(file.buffer);
    const preview = await this.buildPreview(parsed, fileHash);
    if (String(input.baselineHash || '') !== preview.baselineHash) {
      throw new BadRequestException('通讯录数据已变化，请重新预览后再同步');
    }
    if (preview.blockingErrors.length) {
      throw new BadRequestException('文件存在结构错误，请修正后重新预览');
    }
    const selectedIds = Array.isArray(input.selectedIds)
      ? new Set(input.selectedIds.map((value) => String(value)))
      : new Set<string>();
    const allowedIds = new Set(
      preview.items
        .filter((item) => item.category === 'change' || item.category === 'inactive')
        .map((item) => item.id),
    );
    for (const id of selectedIds) {
      if (!allowedIds.has(id)) throw new BadRequestException(`确认项无效：${id}`);
    }
    const result = await this.applySelectedWorkbook(parsed, preview.items, selectedIds);
    return { ...result, fileHash, applied: true };
  }

  async exportWorkbook() {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '人事问卷系统';
    workbook.created = new Date();

    const departmentSheet = workbook.addWorksheet('部门');
    departmentSheet.addRow(['部门编码', '部门名称', '父部门编码', '排序', '状态']);
    const departments = await this.prisma.orgDepartment.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const codeById = new Map(departments.map((row) => [row.id, row.code]));
    departments.forEach((department) =>
      departmentSheet.addRow([
        department.code,
        department.name,
        department.parentId ? codeById.get(department.parentId) || '' : '',
        department.sortOrder,
        department.isActive ? '启用' : '停用',
      ]),
    );

    const employeeSheet = workbook.addWorksheet('员工');
    employeeSheet.addRow([
      '姓名',
      '手机号',
      '工号',
      '职位',
      '邮箱',
      '标签',
      '主部门编码',
      '主部门职责',
      '状态',
    ]);
    const secondarySheet = workbook.addWorksheet('兼任部门');
    secondarySheet.addRow([
      '手机号',
      '工号',
      '部门编码',
      '组织职责',
      '默认参加互评',
    ]);
    const contacts = await this.prisma.contact.findMany({
      include: { memberships: { include: { department: true } } },
      orderBy: { id: 'asc' },
    });
    contacts.forEach((contact) => {
      const primary = contact.memberships.find((row) => row.isPrimary);
      employeeSheet.addRow([
        contact.name,
        contact.phone,
        contact.jobNo || '',
        contact.position || '',
        contact.email || '',
        contact.tags || '',
        primary?.department.code || '',
        primary?.roleName || '',
        contact.isActive ? '启用' : '停用',
      ]);
      contact.memberships
        .filter((row) => !row.isPrimary)
        .forEach((membership) =>
          secondarySheet.addRow([
            contact.phone,
            contact.jobNo || '',
            membership.department.code,
            membership.roleName || '',
            membership.defaultEvalEnabled ? '是' : '否',
          ]),
        );
    });

    [departmentSheet, employeeSheet, secondarySheet].forEach((sheet) => {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE6F4FF' },
      };
      sheet.columns.forEach((column) => {
        column.width = Math.max(14, Math.min(32, column.width || 18));
      });
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private assertWorkbookFile(file: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('请选择 Excel 文件');
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('组织架构仅支持 .xlsx 文件');
    }
  }

  private async parseWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const departmentSheet = workbook.getWorksheet('部门');
    const employeeSheet = workbook.getWorksheet('员工');
    const secondarySheet = workbook.getWorksheet('兼任部门');
    if (!departmentSheet || !employeeSheet || !secondarySheet) {
      throw new BadRequestException('Excel 必须包含“部门、员工、兼任部门”三个工作表');
    }
    const departmentRecords = this.records(departmentSheet);
    const employeeRecords = this.records(employeeSheet);
    const secondaryRecords = this.records(secondarySheet);
    return {
      departments: departmentRecords.map(({ row, values }) => ({
        row,
        code: text(values['部门编码']),
        name: text(values['部门名称']),
        parentCode: nullable(values['父部门编码']),
        sortOrder: Number(text(values['排序']) || 0),
        isActive: enabled(values['状态']),
      })),
      employees: employeeRecords.map(({ row, values }) => ({
        row,
        name: text(values['姓名']),
        phone: normalizeContactPhone(values['手机号']),
        jobNo: nullable(values['工号']),
        position: nullable(values['职位']),
        email: nullable(values['邮箱']),
        tags: nullable(values['标签']),
        primaryDepartmentCode: text(values['主部门编码']),
        primaryRoleName: nullable(values['主部门职责']),
        isActive: enabled(values['状态']),
      })),
      secondaries: secondaryRecords.map(({ row, values }) => ({
        row,
        phone: normalizeContactPhone(values['手机号']),
        departmentCode: text(values['部门编码']),
        roleName: nullable(values['组织职责']),
        defaultEvalEnabled: enabled(values['默认参加互评'], false),
      })),
    };
  }

  private records(sheet: ExcelJS.Worksheet) {
    const headers = (sheet.getRow(1).values as ExcelJS.CellValue[])
      .slice(1)
      .map((value) => text(value));
    const rows: Array<{ row: number; values: Record<string, unknown> }> = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const values: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        if (header) values[header] = row.getCell(index + 1).value;
      });
      if (Object.values(values).some((value) => text(value))) {
        rows.push({ row: rowNumber, values });
      }
    }
    return rows;
  }

  private async buildPreview(parsed: ParsedWorkbook, fileHash: string) {
    const validation = await this.validateWorkbook(parsed, false);
    const [departments, contacts] = await Promise.all([
      this.prisma.orgDepartment.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.contact.findMany({
        include: { memberships: { include: { department: true } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const baselineHash = createHash('sha256')
      .update(
        JSON.stringify({
          departments: departments.map((row) => [
            row.id,
            row.code,
            row.name,
            row.parentId,
            row.sortOrder,
            row.isActive,
            row.updatedAt.toISOString(),
          ]),
          contacts: contacts.map((row) => [
            row.id,
            row.name,
            row.phone,
            row.jobNo,
            row.position,
            row.email,
            row.tags,
            row.isActive,
            row.updatedAt.toISOString(),
            row.memberships
              .map((membership) => [
                membership.department.code,
                membership.isPrimary,
                membership.defaultEvalEnabled,
                membership.roleName,
              ])
              .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
          ]),
        }),
      )
      .digest('hex');
    const items: ImportDiffItem[] = [];
    validation.errors.forEach((error, index) =>
      items.push({
        id: `conflict:validation:${error.sheet}:${error.row}:${index}`,
        category: 'conflict',
        entityType: error.sheet === '部门' ? 'department' : 'contact',
        changeType: '文件错误',
        label: `${error.sheet}第 ${error.row} 行`,
        identity: `${error.sheet}:${error.row}`,
        sheet: error.sheet,
        row: error.row,
        fields: [],
        reason: error.message,
        selectedByDefault: false,
      }),
    );

    const departmentByCode = new Map(departments.map((row) => [row.code, row]));
    const departmentCodeById = new Map(departments.map((row) => [row.id, row.code]));
    const incomingDepartmentCodes = new Set(parsed.departments.map((row) => row.code));
    parsed.departments.forEach((row) => {
      if (!row.code || !row.name) return;
      const current = departmentByCode.get(row.code);
      if (!current) {
        items.push({
          id: `department:create:${row.code}`,
          category: 'create',
          entityType: 'department',
          changeType: '新增部门',
          label: row.name,
          identity: row.code,
          sheet: '部门',
          row: row.row,
          fields: [
            this.diffField('name', '部门名称', '', row.name),
            this.diffField('parentCode', '上级部门', '', row.parentCode || '公司根节点'),
          ],
          selectedByDefault: true,
        });
        return;
      }
      const fields = [
        this.changedField('name', '部门名称', current.name, row.name),
        this.changedField(
          'parentCode',
          '上级部门',
          current.parentId ? departmentCodeById.get(current.parentId) || '' : '公司根节点',
          row.parentCode || '公司根节点',
        ),
        this.changedField('sortOrder', '同级排序', current.sortOrder, row.sortOrder),
        this.changedField('isActive', '状态', this.statusText(current.isActive), this.statusText(row.isActive)),
      ].filter((field): field is DiffField => Boolean(field));
      items.push({
        id: `department:${fields.length ? 'change' : 'unchanged'}:${row.code}`,
        category: fields.length ? 'change' : 'unchanged',
        entityType: 'department',
        changeType: fields.some((field) => field.field === 'parentCode')
          ? '部门移动'
          : '部门资料变更',
        label: row.name,
        identity: row.code,
        sheet: '部门',
        row: row.row,
        fields,
        selectedByDefault: fields.length > 0,
      });
    });
    departments
      .filter((row) => row.isActive && !incomingDepartmentCodes.has(row.code))
      .forEach((row) =>
        items.push({
          id: `department:inactive:${row.code}`,
          category: 'inactive',
          entityType: 'department',
          changeType: '停用候选',
          label: row.name,
          identity: row.code,
          sheet: '部门',
          row: 0,
          fields: [this.diffField('isActive', '状态', '启用', '停用')],
          reason: '最新全量文件中不存在该部门',
          selectedByDefault: true,
        }),
      );

    const contactsByPhone = this.groupBy(contacts, (row) => row.phone);
    const contactsByJobNo = this.groupBy(
      contacts.filter((row) => Boolean(row.jobNo)),
      (row) => row.jobNo || '',
    );
    const secondaryByPhone = this.groupBy(parsed.secondaries, (row) => row.phone);
    const touchedContactIds = new Set<number>();
    const matchedContactIds = new Set<number>();

    parsed.employees.forEach((row) => {
      if (!row.name || !row.phone || !row.primaryDepartmentCode) return;
      const phoneMatches = contactsByPhone.get(row.phone) || [];
      const jobMatches = row.jobNo ? contactsByJobNo.get(row.jobNo) || [] : [];
      [...phoneMatches, ...jobMatches].forEach((contact) => touchedContactIds.add(contact.id));
      const identityError = this.identityConflict(phoneMatches, jobMatches);
      if (identityError) {
        items.push({
          id: `contact:conflict:${row.row}:${row.phone}`,
          category: 'conflict',
          entityType: 'contact',
          changeType: '身份冲突',
          label: row.name,
          identity: row.phone,
          sheet: '员工',
          row: row.row,
          fields: [],
          reason: identityError,
          selectedByDefault: false,
        });
        return;
      }
      const current = phoneMatches[0] || jobMatches[0];
      if (!current) {
        items.push({
          id: `contact:create:${row.phone}`,
          category: 'create',
          entityType: 'contact',
          changeType: '新增员工',
          label: row.name,
          identity: row.phone,
          sheet: '员工',
          row: row.row,
          fields: [
            this.diffField('name', '姓名', '', row.name),
            this.diffField('phone', '手机号', '', row.phone),
            this.diffField('primaryDepartmentCode', '主部门', '', row.primaryDepartmentCode),
          ],
          selectedByDefault: true,
        });
        return;
      }
      matchedContactIds.add(current.id);
      const primary = current.memberships.find((membership) => membership.isPrimary);
      const oldSecondaries = current.memberships
        .filter((membership) => !membership.isPrimary)
        .map((membership) => this.secondaryText(
          membership.department.code,
          membership.roleName,
          membership.defaultEvalEnabled,
        ))
        .sort();
      const newSecondaries = (secondaryByPhone.get(row.phone) || [])
        .map((membership) => this.secondaryText(
          membership.departmentCode,
          membership.roleName,
          membership.defaultEvalEnabled,
        ))
        .sort();
      const fields = [
        this.changedField('name', '姓名', current.name, row.name),
        this.changedField('phone', '手机号', current.phone, row.phone),
        this.changedField('jobNo', '工号', current.jobNo, row.jobNo),
        this.changedField('position', '职位', current.position, row.position),
        this.changedField('email', '邮箱', current.email, row.email),
        this.changedField('tags', '标签', current.tags, row.tags),
        this.changedField('primaryDepartmentCode', '主部门', primary?.department.code, row.primaryDepartmentCode),
        this.changedField('primaryRoleName', '主部门职责', primary?.roleName, row.primaryRoleName),
        this.changedField('secondaries', '兼任部门', oldSecondaries.join('；'), newSecondaries.join('；')),
        this.changedField('isActive', '状态', this.statusText(current.isActive), this.statusText(row.isActive)),
      ].filter((field): field is DiffField => Boolean(field));
      const isTransfer = fields.some((field) => field.field === 'primaryDepartmentCode');
      const isSecondaryChange = fields.some((field) => field.field === 'secondaries');
      items.push({
        id: `contact:${fields.length ? 'change' : 'unchanged'}:${current.id}`,
        category: fields.length ? 'change' : 'unchanged',
        entityType: 'contact',
        changeType: isTransfer ? '调岗' : isSecondaryChange ? '兼任调整' : '资料变更',
        label: row.name,
        identity: row.jobNo || row.phone,
        sheet: '员工',
        row: row.row,
        fields,
        selectedByDefault: fields.length > 0,
      });
    });
    contacts
      .filter(
        (row) => row.isActive && !matchedContactIds.has(row.id) && !touchedContactIds.has(row.id),
      )
      .forEach((row) =>
        items.push({
          id: `contact:inactive:${row.id}`,
          category: 'inactive',
          entityType: 'contact',
          changeType: '停用候选',
          label: row.name,
          identity: row.jobNo || row.phone,
          sheet: '员工',
          row: 0,
          fields: [this.diffField('isActive', '状态', '启用', '停用')],
          reason: '最新全量文件中不存在该员工',
          selectedByDefault: true,
        }),
      );

    return {
      fileHash,
      baselineHash,
      summary: {
        totalDepartments: parsed.departments.length,
        totalEmployees: parsed.employees.length,
        create: items.filter((item) => item.category === 'create').length,
        change: items.filter((item) => item.category === 'change').length,
        inactive: items.filter((item) => item.category === 'inactive').length,
        conflict: items.filter((item) => item.category === 'conflict').length,
        unchanged: items.filter((item) => item.category === 'unchanged').length,
      },
      blockingErrors: validation.errors,
      items,
      applied: false,
    };
  }

  private groupBy<T>(rows: T[], keyOf: (row: T) => string) {
    const result = new Map<string, T[]>();
    rows.forEach((row) => {
      const key = keyOf(row);
      result.set(key, [...(result.get(key) || []), row]);
    });
    return result;
  }

  private identityConflict<T extends { id: number }>(phoneMatches: T[], jobMatches: T[]) {
    if (phoneMatches.length > 1) return '系统中有多名员工使用该手机号，无法确定更新对象';
    if (jobMatches.length > 1) return '系统中有多名员工使用该工号，无法确定更新对象';
    if (phoneMatches[0] && jobMatches[0] && phoneMatches[0].id !== jobMatches[0].id) {
      return '手机号匹配员工与工号匹配员工不是同一人';
    }
    return null;
  }

  private statusText(value: boolean) {
    return value ? '启用' : '停用';
  }

  private secondaryText(code: string, roleName: string | null, evalEnabled: boolean) {
    return `${code}${roleName ? ` · ${roleName}` : ''}${evalEnabled ? ' · 参与互评' : ''}`;
  }

  private diffField(field: string, label: string, before: unknown, after: unknown): DiffField {
    return {
      field,
      label,
      before: String(before ?? '') || '—',
      after: String(after ?? '') || '—',
    };
  }

  private changedField(field: string, label: string, before: unknown, after: unknown) {
    const oldValue = String(before ?? '');
    const newValue = String(after ?? '');
    return oldValue === newValue ? null : this.diffField(field, label, oldValue, newValue);
  }

  private async validateWorkbook(parsed: ParsedWorkbook, includeIdentityErrors = true) {
    const errors: Array<{ sheet: string; row: number; message: string }> = [];
    const existingDepartments = await this.prisma.orgDepartment.findMany();
    const existingByCode = new Map(existingDepartments.map((row) => [row.code, row]));
    const incomingByCode = new Map<string, DepartmentImportRow>();
    parsed.departments.forEach((row) => {
      if (!row.code || !row.name) {
        errors.push({ sheet: '部门', row: row.row, message: '部门编码和部门名称必填' });
        return;
      }
      if (incomingByCode.has(row.code)) {
        errors.push({ sheet: '部门', row: row.row, message: `部门编码重复：${row.code}` });
      }
      if (!Number.isInteger(row.sortOrder)) {
        errors.push({ sheet: '部门', row: row.row, message: '排序必须是整数' });
      }
      incomingByCode.set(row.code, row);
    });
    const knownCodes = new Set([...existingByCode.keys(), ...incomingByCode.keys()]);
    parsed.departments.forEach((row) => {
      if (row.parentCode && !knownCodes.has(row.parentCode)) {
        errors.push({ sheet: '部门', row: row.row, message: `父部门编码不存在：${row.parentCode}` });
      }
      if (row.parentCode === row.code) {
        errors.push({ sheet: '部门', row: row.row, message: '部门不能把自己设为父部门' });
      }
    });

    const parentByCode = new Map<string, string | null>();
    existingDepartments.forEach((row) =>
      parentByCode.set(row.code, row.parentId ? existingDepartments.find((item) => item.id === row.parentId)?.code || null : null),
    );
    parsed.departments.forEach((row) => parentByCode.set(row.code, row.parentCode));
    parentByCode.forEach((_parent, code) => {
      const seen = new Set<string>();
      let current: string | null | undefined = code;
      while (current) {
        if (seen.has(current)) {
          const row = incomingByCode.get(code);
          errors.push({ sheet: '部门', row: row?.row || 1, message: `部门层级形成循环：${code}` });
          break;
        }
        seen.add(current);
        current = parentByCode.get(current);
      }
    });
    const parentCodes = new Set(Array.from(parentByCode.values()).filter((value): value is string => Boolean(value)));

    const incomingPhones = new Map<string, EmployeeImportRow>();
    parsed.employees.forEach((row) => {
      if (!row.name || !row.phone || !row.primaryDepartmentCode) {
        errors.push({ sheet: '员工', row: row.row, message: '姓名、手机号和主部门编码必填' });
        return;
      }
      if (incomingPhones.has(row.phone) && includeIdentityErrors) {
        errors.push({ sheet: '员工', row: row.row, message: `手机号在员工表中重复：${row.phone}` });
      }
      incomingPhones.set(row.phone, row);
      if (!knownCodes.has(row.primaryDepartmentCode)) {
        errors.push({ sheet: '员工', row: row.row, message: `主部门编码不存在：${row.primaryDepartmentCode}` });
      } else if (parentCodes.has(row.primaryDepartmentCode)) {
        errors.push({ sheet: '员工', row: row.row, message: '员工只能归属到末级部门' });
      }
    });

    const secondaryKeys = new Set<string>();
    parsed.secondaries.forEach((row) => {
      if (!row.phone || !row.departmentCode) {
        errors.push({ sheet: '兼任部门', row: row.row, message: '手机号和部门编码必填' });
        return;
      }
      const employee = incomingPhones.get(row.phone);
      if (!employee) {
        errors.push({ sheet: '兼任部门', row: row.row, message: `员工表中不存在手机号：${row.phone}` });
      }
      if (!knownCodes.has(row.departmentCode)) {
        errors.push({ sheet: '兼任部门', row: row.row, message: `部门编码不存在：${row.departmentCode}` });
      } else if (parentCodes.has(row.departmentCode)) {
        errors.push({ sheet: '兼任部门', row: row.row, message: '兼任部门必须是末级部门' });
      }
      if (employee?.primaryDepartmentCode === row.departmentCode) {
        errors.push({ sheet: '兼任部门', row: row.row, message: '兼任部门不能与主部门相同' });
      }
      const key = `${row.phone}:${row.departmentCode}`;
      if (secondaryKeys.has(key)) {
        errors.push({ sheet: '兼任部门', row: row.row, message: '同一员工的兼任部门重复' });
      }
      secondaryKeys.add(key);
    });

    const phones = Array.from(incomingPhones.keys());
    const existingContacts = phones.length
      ? await this.prisma.contact.findMany({ where: { phone: { in: phones } }, select: { phone: true } })
      : [];
    const counts = new Map<string, number>();
    existingContacts.forEach((row) => counts.set(row.phone, (counts.get(row.phone) || 0) + 1));
    counts.forEach((count, phone) => {
      if (!includeIdentityErrors) return;
      if (count > 1) {
        const row = incomingPhones.get(phone);
        errors.push({ sheet: '员工', row: row?.row || 1, message: `系统中有多名联系人共用手机号：${phone}` });
      }
    });

    return {
      summary: {
        departments: parsed.departments.length,
        employees: parsed.employees.length,
        secondaryMemberships: parsed.secondaries.length,
        errors: errors.length,
      },
      errors,
      applied: false,
    };
  }

  private async applySelectedWorkbook(
    parsed: ParsedWorkbook,
    items: ImportDiffItem[],
    selectedIds: Set<string>,
  ) {
    const itemById = new Map(items.map((item) => [item.id, item]));
    let created = 0;
    let changed = 0;
    let inactivated = 0;
    let conflictsSkipped = items.filter((item) => item.category === 'conflict').length;

    await this.prisma.$transaction(async (tx) => {
      const existingDepartments = await tx.orgDepartment.findMany();
      const departmentByCode = new Map(existingDepartments.map((row) => [row.code, row]));
      const pending = parsed.departments.filter((row) => {
        const item = itemById.get(`department:create:${row.code}`)
          || itemById.get(`department:change:${row.code}`);
        return item?.category === 'create' || (item?.category === 'change' && selectedIds.has(item.id));
      });
      while (pending.length) {
        let progressed = false;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const row = pending[index];
          const parent = row.parentCode ? departmentByCode.get(row.parentCode) : null;
          if (row.parentCode && !parent) continue;
          const current = departmentByCode.get(row.code);
          const saved = current
            ? await tx.orgDepartment.update({
                where: { id: current.id },
                data: {
                  name: row.name,
                  parentId: parent?.id || null,
                  sortOrder: row.sortOrder,
                  isActive: row.isActive,
                },
              })
            : await tx.orgDepartment.create({
                data: {
                  code: row.code,
                  name: row.name,
                  parentId: parent?.id || null,
                  sortOrder: row.sortOrder,
                  isActive: row.isActive,
                },
              });
          if (current) changed += 1;
          else created += 1;
          departmentByCode.set(saved.code, saved);
          pending.splice(index, 1);
          progressed = true;
        }
        if (!progressed) throw new BadRequestException('部门层级无法解析');
      }

      const selectedInactiveDepartments = items.filter(
        (item) => item.entityType === 'department'
          && item.category === 'inactive'
          && selectedIds.has(item.id),
      );
      if (selectedInactiveDepartments.length) {
        const result = await tx.orgDepartment.updateMany({
          where: { code: { in: selectedInactiveDepartments.map((item) => item.identity) } },
          data: { isActive: false },
        });
        inactivated += result.count;
      }

      const allDepartments = await tx.orgDepartment.findMany();
      const latestDepartmentByCode = new Map(allDepartments.map((row) => [row.code, row]));
      const pathMap = this.pathMap(allDepartments);
      const existingContacts = await tx.contact.findMany();
      const contactsByPhone = this.groupBy(existingContacts, (row) => row.phone);
      const contactsByJobNo = this.groupBy(
        existingContacts.filter((row) => Boolean(row.jobNo)),
        (row) => row.jobNo || '',
      );
      const secondaryByPhone = this.groupBy(parsed.secondaries, (row) => row.phone);

      for (const row of parsed.employees) {
        const phoneMatches = contactsByPhone.get(row.phone) || [];
        const jobMatches = row.jobNo ? contactsByJobNo.get(row.jobNo) || [] : [];
        if (this.identityConflict(phoneMatches, jobMatches)) continue;
        const current = phoneMatches[0] || jobMatches[0];
        const createItem = itemById.get(`contact:create:${row.phone}`);
        const changeItem = current ? itemById.get(`contact:change:${current.id}`) : null;
        const shouldCreate = Boolean(createItem);
        const shouldChange = Boolean(changeItem && selectedIds.has(changeItem.id));
        if (!shouldCreate && !shouldChange) continue;
        const primaryDepartment = latestDepartmentByCode.get(row.primaryDepartmentCode);
        if (!primaryDepartment) continue;
        const data = {
          name: row.name,
          phone: row.phone,
          jobNo: row.jobNo,
          position: row.position,
          email: row.email,
          tags: row.tags,
          isActive: row.isActive,
          department: pathMap.get(primaryDepartment.id) || primaryDepartment.name,
        };
        const contact = current
          ? await tx.contact.update({ where: { id: current.id }, data })
          : await tx.contact.create({ data });
        if (current) changed += 1;
        else created += 1;
        await tx.contactDepartmentMembership.deleteMany({ where: { contactId: contact.id } });
        await tx.contactDepartmentMembership.create({
          data: {
            contactId: contact.id,
            departmentId: primaryDepartment.id,
            isPrimary: true,
            defaultEvalEnabled: true,
            roleName: row.primaryRoleName,
          },
        });
        const secondaries = secondaryByPhone.get(row.phone) || [];
        if (secondaries.length) {
          await tx.contactDepartmentMembership.createMany({
            data: secondaries.map((secondary) => ({
              contactId: contact.id,
              departmentId: latestDepartmentByCode.get(secondary.departmentCode)!.id,
              isPrimary: false,
              defaultEvalEnabled: secondary.defaultEvalEnabled,
              roleName: secondary.roleName,
            })),
          });
        }
      }

      const selectedInactiveContacts = items.filter(
        (item) => item.entityType === 'contact'
          && item.category === 'inactive'
          && selectedIds.has(item.id),
      );
      if (selectedInactiveContacts.length) {
        const ids = selectedInactiveContacts
          .map((item) => Number(item.id.split(':').at(-1)))
          .filter((id) => Number.isInteger(id));
        const result = await tx.contact.updateMany({
          where: { id: { in: ids } },
          data: { isActive: false },
        });
        inactivated += result.count;
      }
    }, { timeout: 30_000 });

    return { created, changed, inactivated, conflictsSkipped };
  }

  private async applyWorkbook(parsed: ParsedWorkbook) {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.orgDepartment.findMany();
      const byCode = new Map(existing.map((row) => [row.code, row]));
      const pending = [...parsed.departments];
      while (pending.length) {
        let progressed = false;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const row = pending[index];
          const parent = row.parentCode ? byCode.get(row.parentCode) : null;
          if (row.parentCode && !parent) continue;
          const saved = await tx.orgDepartment.upsert({
            where: { code: row.code },
            create: {
              code: row.code,
              name: row.name,
              parentId: parent?.id || null,
              sortOrder: row.sortOrder,
              isActive: row.isActive,
            },
            update: {
              name: row.name,
              parentId: parent?.id || null,
              sortOrder: row.sortOrder,
              isActive: row.isActive,
            },
          });
          byCode.set(saved.code, saved);
          pending.splice(index, 1);
          progressed = true;
        }
        if (!progressed) throw new BadRequestException('部门层级无法解析');
      }

      const allDepartments = await tx.orgDepartment.findMany();
      const departmentByCode = new Map(allDepartments.map((row) => [row.code, row]));
      const pathMap = this.pathMap(allDepartments);
      const secondaryByPhone = new Map<string, SecondaryImportRow[]>();
      parsed.secondaries.forEach((row) => {
        const list = secondaryByPhone.get(row.phone) || [];
        list.push(row);
        secondaryByPhone.set(row.phone, list);
      });

      for (const row of parsed.employees) {
        const matches = await tx.contact.findMany({ where: { phone: row.phone }, select: { id: true } });
        const primaryDepartment = departmentByCode.get(row.primaryDepartmentCode)!;
        const data = {
          name: row.name,
          phone: row.phone,
          jobNo: row.jobNo,
          position: row.position,
          email: row.email,
          tags: row.tags,
          isActive: row.isActive,
          department: pathMap.get(primaryDepartment.id) || primaryDepartment.name,
        };
        const contact = matches[0]
          ? await tx.contact.update({ where: { id: matches[0].id }, data })
          : await tx.contact.create({ data });
        await tx.contactDepartmentMembership.deleteMany({ where: { contactId: contact.id } });
        await tx.contactDepartmentMembership.create({
          data: {
            contactId: contact.id,
            departmentId: primaryDepartment.id,
            isPrimary: true,
            defaultEvalEnabled: true,
            roleName: row.primaryRoleName,
          },
        });
        const secondaries = secondaryByPhone.get(row.phone) || [];
        if (secondaries.length) {
          await tx.contactDepartmentMembership.createMany({
            data: secondaries.map((secondary) => ({
              contactId: contact.id,
              departmentId: departmentByCode.get(secondary.departmentCode)!.id,
              isPrimary: false,
              defaultEvalEnabled: secondary.defaultEvalEnabled,
              roleName: secondary.roleName,
            })),
          });
        }
      }
    }, { timeout: 30_000 });
  }

  private pathMap(departments: Array<{ id: number; name: string; parentId: number | null }>) {
    const byId = new Map(departments.map((row) => [row.id, row]));
    const cache = new Map<number, string>();
    const resolve = (id: number): string => {
      const cached = cache.get(id);
      if (cached) return cached;
      const current = byId.get(id);
      if (!current) return '';
      const parent = current.parentId ? resolve(current.parentId) : '';
      const value = parent ? `${parent}/${current.name}` : current.name;
      cache.set(id, value);
      return value;
    };
    departments.forEach((row) => resolve(row.id));
    return cache;
  }
}
