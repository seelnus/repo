import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from './prisma.service';

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
    const contacts = await this.prisma.contact.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, department: true } });
    return contacts;
  }

  async devFillLogin(contactId: number) {
    this.assertDevLoginAllowed();
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException('联系人不存在');
    const token = this.jwt.sign(
      { sub: contact.id, wecomUserid: `dev-${contact.id}`, name: contact.name, type: 'fill' },
      { expiresIn: '24h' },
    );
    return { token, name: contact.name };
  }

  // ── 批次 CRUD ──

  async listCycles() {
    const cycles = await this.prisma.evalCycle.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { relations: true } } },
    });
    return cycles.map(({ _count, ...c }) => ({ ...c, relationCount: _count.relations }));
  }

  async getCycle(id: number) {
    const cycle = await this.prisma.evalCycle.findUnique({ where: { id } });
    if (!cycle) throw new NotFoundException('评价批次不存在');
    return cycle;
  }

  async createCycle(adminId: number, data: any) {
    const name = String(data?.name || '').trim();
    if (!name) throw new BadRequestException('批次名称不能为空');
    return this.prisma.evalCycle.create({
      data: {
        name,
        scopeDepartment: data.scopeDepartment ? String(data.scopeDepartment) : null,
        selfSurveyId: toIdOrNull(data.selfSurveyId),
        peerSurveyId: toIdOrNull(data.peerSurveyId),
        leaderSurveyId: toIdOrNull(data.leaderSurveyId),
        createdBy: adminId,
      },
    });
  }

  async updateCycle(id: number, data: any) {
    await this.getCycle(id);
    return this.prisma.evalCycle.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: String(data.name).trim() } : {}),
        ...(data.scopeDepartment !== undefined ? { scopeDepartment: data.scopeDepartment ? String(data.scopeDepartment) : null } : {}),
        ...(data.selfSurveyId !== undefined ? { selfSurveyId: toIdOrNull(data.selfSurveyId) } : {}),
        ...(data.peerSurveyId !== undefined ? { peerSurveyId: toIdOrNull(data.peerSurveyId) } : {}),
        ...(data.leaderSurveyId !== undefined ? { leaderSurveyId: toIdOrNull(data.leaderSurveyId) } : {}),
        ...(data.status !== undefined ? { status: String(data.status) } : {}),
      },
    });
  }

  async deleteCycle(id: number) {
    await this.getCycle(id);
    // eval_relations 通过外键 onDelete: Cascade 一并删除
    await this.prisma.evalCycle.delete({ where: { id } });
    return { ok: true };
  }

  // ── 关系自动生成 ──

  /**
   * 按 department 分组，为范围内普通员工生成自评 + 互评关系。
   * 只覆盖 source=auto 的记录（重新生成时不冲掉 source=manual 的人工配置）。
   */
  async generateRelations(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    if (!cycle.scopeDepartment) throw new BadRequestException('请先设置参评范围（部门/组）');
    if (!cycle.selfSurveyId || !cycle.peerSurveyId) {
      throw new BadRequestException('请先绑定自评问卷和他评问卷');
    }

    const members = await this.prisma.contact.findMany({
      where: { department: cycle.scopeDepartment },
      orderBy: { id: 'asc' },
    });
    const leaderIds = new Set(members.filter((m) => isLeaderTag(m.tags)).map((m) => m.id));
    const memberIds = members.map((m) => m.id);

    const rels = buildAutoRelations(memberIds, leaderIds, cycle.selfSurveyId, cycle.peerSurveyId);

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
    if (normalCount === 1) warnings.push('该组只有 1 名普通员工，无法互评，请人工配置（跨组/豁免/仅自评）');
    if (normalCount === 0) warnings.push('该范围内没有普通员工（可能全是领导或范围为空），请检查参评范围与领导标记');

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

  // ── 复核列表 = 异常报告（实时聚合，不落快照）──

  async getReviewList(cycleId: number) {
    const cycle = await this.getCycle(cycleId);
    const relations = await this.prisma.evalRelation.findMany({ where: { cycleId } });

    // 行集合 = 参评范围成员 ∪ 关系里出现过的所有人（含人工配置到范围外的人）
    const scopeMembers = cycle.scopeDepartment
      ? await this.prisma.contact.findMany({ where: { department: cycle.scopeDepartment } })
      : [];
    const ids = new Set<number>();
    scopeMembers.forEach((m) => ids.add(m.id));
    relations.forEach((r) => {
      ids.add(r.raterContactId);
      ids.add(r.rateeContactId);
    });
    const contacts = await this.prisma.contact.findMany({ where: { id: { in: Array.from(ids) } } });
    const contactMap = new Map(contacts.map((c) => [c.id, c]));

    const rows = Array.from(ids).map((id) => {
      const c = contactMap.get(id);
      const isLeader = isLeaderTag(c?.tags);
      const involved = relations.filter((r) => r.raterContactId === id || r.rateeContactId === id);
      const selfRel = relations.find((r) => r.relationType === 'self' && r.raterContactId === id && r.rateeContactId === id);
      const ratedBy = relations.filter((r) => r.rateeContactId === id && r.raterContactId !== id); // 别人评他
      const rating = relations.filter((r) => r.raterContactId === id && r.rateeContactId !== id); // 他评别人
      const sources = new Set(involved.map((r) => r.source));
      const source = involved.length === 0 ? 'none' : sources.size > 1 ? 'mixed' : Array.from(sources)[0];

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
    rows.sort((a, b) => (a.status === b.status ? a.contactId - b.contactId : a.status === '异常' ? -1 : 1));

    const has = (t: string) => rows.filter((r) => r.anomalies.includes(t)).length;
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

  // ── 关系明细 / 人工配置（领导 + 异常补配）──

  async listRelations(cycleId: number) {
    await this.getCycle(cycleId);
    const relations = await this.prisma.evalRelation.findMany({ where: { cycleId }, orderBy: { id: 'asc' } });
    const ids = new Set<number>();
    relations.forEach((r) => {
      ids.add(r.raterContactId);
      ids.add(r.rateeContactId);
    });
    const contacts = await this.prisma.contact.findMany({ where: { id: { in: Array.from(ids) } } });
    const nameOf = new Map(contacts.map((c) => [c.id, c.name]));
    return relations.map((r) => ({
      ...r,
      raterName: nameOf.get(r.raterContactId) ?? `#${r.raterContactId}`,
      rateeName: nameOf.get(r.rateeContactId) ?? `#${r.rateeContactId}`,
      done: !!r.responseId,
    }));
  }

  async addManualRelation(cycleId: number, data: any) {
    const cycle = await this.getCycle(cycleId);
    const rater = Number(data?.raterContactId);
    const ratee = Number(data?.rateeContactId);
    const relationType = String(data?.relationType || '');
    if (!['self', 'peer', 'leader'].includes(relationType)) throw new BadRequestException('关系类型必须是 self/peer/leader');
    if (!Number.isInteger(rater) || rater <= 0 || !Number.isInteger(ratee) || ratee <= 0) {
      throw new BadRequestException('评价人/被评人不合法');
    }
    if (relationType === 'self' && rater !== ratee) throw new BadRequestException('自评的评价人和被评人必须是同一人');

    // 问卷模板：优先用传入的，否则按关系类型取批次默认模板
    const surveyId = toIdOrNull(data?.surveyId)
      ?? (relationType === 'self' ? cycle.selfSurveyId : relationType === 'leader' ? cycle.leaderSurveyId : cycle.peerSurveyId);
    if (!surveyId) throw new BadRequestException('未指定问卷模板，且批次未绑定该类型的默认模板');

    const count = await this.prisma.contact.count({ where: { id: { in: [rater, ratee] } } });
    if (count !== new Set([rater, ratee]).size) throw new BadRequestException('评价人或被评人不存在');

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
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('该评价关系已存在（同一批次内评价人+被评人唯一）');
      }
      throw e;
    }
  }

  async deleteRelation(relationId: number) {
    const rel = await this.prisma.evalRelation.findUnique({ where: { id: relationId } });
    if (!rel) throw new NotFoundException('评价关系不存在');
    if (rel.responseId) throw new BadRequestException('该关系已有人提交答卷，不能删除');
    await this.prisma.evalRelation.delete({ where: { id: relationId } });
    return { ok: true };
  }

  // ── 填写端：待我填写 + 逐份提交 ──

  async listMyTasks(fillUser: EvalFillUser) {
    const relations = await this.prisma.evalRelation.findMany({
      where: { raterContactId: fillUser.sub, cycle: { status: { not: 'closed' } } },
      include: { cycle: true },
      orderBy: [{ cycleId: 'desc' }, { id: 'asc' }],
    });
    const rateeIds = Array.from(new Set(relations.map((r) => r.rateeContactId)));
    const surveyIds = Array.from(new Set(relations.map((r) => r.surveyId)));
    const [ratees, surveys] = await Promise.all([
      this.prisma.contact.findMany({ where: { id: { in: rateeIds } } }),
      this.prisma.survey.findMany({ where: { id: { in: surveyIds } }, select: { id: true, title: true } }),
    ]);
    const rateeName = new Map(ratees.map((c) => [c.id, c.name]));
    const surveyTitle = new Map(surveys.map((s) => [s.id, s.title]));

    const byCycle = new Map<number, any>();
    for (const r of relations) {
      if (!byCycle.has(r.cycleId)) {
        byCycle.set(r.cycleId, { cycleId: r.cycleId, cycleName: r.cycle.name, cycleStatus: r.cycle.status, tasks: [] });
      }
      byCycle.get(r.cycleId).tasks.push({
        relationId: r.id,
        type: r.relationType,
        rateeContactId: r.rateeContactId,
        rateeName: r.relationType === 'self' ? '本人（自评）' : rateeName.get(r.rateeContactId) ?? `#${r.rateeContactId}`,
        surveyId: r.surveyId,
        surveyTitle: surveyTitle.get(r.surveyId) ?? '',
        done: !!r.responseId,
      });
    }
    return Array.from(byCycle.values());
  }

  async getTask(relationId: number, fillUser: EvalFillUser) {
    const rel = await this.prisma.evalRelation.findUnique({ where: { id: relationId } });
    if (!rel) throw new NotFoundException('填写任务不存在');
    if (rel.raterContactId !== fillUser.sub) throw new ForbiddenException('这不是分配给你的填写任务');
    const survey = await this.prisma.survey.findUnique({ where: { id: rel.surveyId } });
    if (!survey) throw new NotFoundException('问卷模板不存在');
    const ratee = rel.relationType === 'self' ? null : await this.prisma.contact.findUnique({ where: { id: rel.rateeContactId } });
    return {
      relationId: rel.id,
      type: rel.relationType,
      done: !!rel.responseId,
      rateeName: rel.relationType === 'self' ? '本人（自评）' : ratee?.name ?? `#${rel.rateeContactId}`,
      survey: { id: survey.id, title: survey.title, schemaJson: survey.schemaJson },
    };
  }

  async submitTask(relationId: number, answersJson: Record<string, unknown>, fillUser: EvalFillUser) {
    const rel = await this.prisma.evalRelation.findUnique({ where: { id: relationId } });
    if (!rel) throw new NotFoundException('填写任务不存在');
    if (rel.raterContactId !== fillUser.sub) throw new ForbiddenException('这不是分配给你的填写任务');
    if (rel.responseId) throw new ConflictException('该任务你已提交，无需重复填写');

    // ponytail: 必填校验交给前端；此处只保证归属+去重两道后端闸门，不复制 AppService 的题目校验器
    return this.prisma.$transaction(async (tx) => {
      const response = await tx.surveyResponse.create({
        data: {
          surveyId: rel.surveyId,
          wecomUserid: fillUser.wecomUserid,
          rateeContactId: rel.rateeContactId,
          answersJson: answersJson as Prisma.InputJsonValue,
        },
      });
      await tx.evalRelation.update({ where: { id: rel.id }, data: { responseId: response.id } });
      return { ok: true, responseId: response.id };
    });
  }

  // ── 结果导出（Excel，三分表：自评/他评/领导评价，答案按题拆列）──

  async exportCycle(cycleId: number): Promise<ExcelJS.Buffer> {
    const cycle = await this.getCycle(cycleId);
    const rows = await this.listRelations(cycleId);
    const responseIds = rows.map((r) => r.responseId).filter((x): x is number => !!x);
    const responses = await this.prisma.surveyResponse.findMany({ where: { id: { in: responseIds } } });
    const answerOf = new Map(responses.map((r) => [r.id, r.answersJson as Record<string, unknown>]));
    const submittedAt = new Map(responses.map((r) => [r.id, r.submittedAt]));

    // 三份模板的题目（描述题不占列）
    const templateIds = [cycle.selfSurveyId, cycle.peerSurveyId, cycle.leaderSurveyId].filter((x): x is number => !!x);
    const surveys = await this.prisma.survey.findMany({ where: { id: { in: templateIds } } });
    const questionsOf = (surveyId: number | null) => {
      if (!surveyId) return [];
      const s = surveys.find((x) => x.id === surveyId);
      const qs = (((s?.schemaJson as any)?.questions) || []) as Array<{ id: string; type: string; label: string }>;
      return qs.filter((q) => q.type !== 'description');
    };

    const wb = new ExcelJS.Workbook();
    const sheets: Array<{ type: string; label: string; surveyId: number | null }> = [
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
        ...questions.map((q, i) => ({ header: `Q${i + 1} ${q.label}`, key: `q_${q.id}`, width: 24 })),
      ];
      ws.getRow(1).font = { bold: true };

      for (const r of rows.filter((x) => x.relationType === sheet.type)) {
        const ans = r.responseId ? answerOf.get(r.responseId) ?? {} : {};
        const row: Record<string, unknown> = {
          cycle: cycle.name,
          type: sheet.label,
          rater: r.raterName,
          ratee: r.rateeName,
          submitted: r.done ? '已提交' : '未提交',
          time: r.responseId ? new Date(submittedAt.get(r.responseId)!).toLocaleString('zh-CN') : '',
        };
        for (const q of questions) row[`q_${q.id}`] = formatAnswer(ans[q.id]);
        ws.addRow(row);
      }
    }

    return wb.xlsx.writeBuffer();
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
  return s.startsWith('__other__:') ? `其他：${s.slice('__other__:'.length)}` : s;
}

function toIdOrNull(v: any): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
