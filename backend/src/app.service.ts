import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, SurveyStatus, SurveyType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { stringify } from 'csv-stringify/sync';
import { randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';
import { SurveyQuestion, SurveySchema, emptySurveySchema } from './app.types';

interface FillUser {
  sub: number;
  wecomUserid: string;
  name: string;
  type: 'fill';
}

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  health() {
    return { ok: true };
  }

  async login(phone: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { phone } });
    if (!admin) throw new UnauthorizedException('手机号或密码错误');

    const matched = await bcrypt.compare(password, admin.passwordHash);
    if (!matched) throw new UnauthorizedException('手机号或密码错误');

    return {
      token: this.jwt.sign({ sub: admin.id, name: admin.name, phone: admin.phone }),
      admin: this.publicAdmin(admin),
    };
  }

  async listMembers() {
    const members = await this.prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
    return members.map((item) => this.publicAdmin(item));
  }

  async createMember(data: { name: string; phone: string; password: string }) {
    const passwordHash = await bcrypt.hash(data.password, 10);
    const member = await this.prisma.adminUser.create({
      data: { name: data.name, phone: data.phone, passwordHash },
    });
    return this.publicAdmin(member);
  }

  async deleteMember(id: number) {
    const member = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('成员不存在');
    if (member.isPrimary) throw new ForbiddenException('该账号为主账号，无法删除');
    await this.prisma.adminUser.delete({ where: { id } });
    return { ok: true };
  }

  async listContacts(query?: string) {
    return this.prisma.contact.findMany({
      where: query
        ? {
            OR: [
              { name: { contains: query } },
              { department: { contains: query } },
              { jobNo: { contains: query } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createContact(data: any) {
    return this.prisma.contact.create({ data: this.contactData(data, true) });
  }

  async updateContact(id: number, data: any) {
    return this.prisma.contact.update({ where: { id }, data: this.contactData(data, true) });
  }

  async deleteContact(id: number) {
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }

  async importContacts(rows: any[]) {
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const data = this.contactData({
        name: row.name || row['姓名'],
        department: row.department || row['部门'],
        jobNo: row.jobNo || row.job_no || row['工号'],
        position: row.position || row['职位'],
        phone: row.phone || row['手机号'],
        email: row.email || row['邮箱'],
        tags: row.tags || row['标签'],
      });
      if (!data.name || !data.phone) {
        skipped += 1;
        continue;
      }
      await this.prisma.contact.upsert({
        where: { name: data.name },
        create: data,
        update: data,
      });
      count += 1;
    }
    return { count, skipped };
  }

  async exportContacts() {
    const contacts = await this.prisma.contact.findMany({ orderBy: { createdAt: 'desc' } });
    return stringify(
      contacts.map((item) => ({
        姓名: item.name,
        部门: item.department || '',
        工号: item.jobNo || '',
        职位: item.position || '',
        手机号: item.phone || '',
        邮箱: item.email || '',
        标签: item.tags || '',
      })),
      { header: true, bom: true },
    );
  }

  async listSurveys(query: { keyword?: string; type?: SurveyType; folderId?: number | 'unclassified' }) {
    const folderFilter =
      query.folderId === 'unclassified'
        ? { folderId: null }
        : query.folderId !== undefined
        ? { folderId: query.folderId as number }
        : {};
    return this.prisma.survey.findMany({
      where: {
        isDeleted: false,
        title: query.keyword ? { contains: query.keyword } : undefined,
        type: query.type || undefined,
        ...folderFilter,
      },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        shareToken: true,
        createdAt: true,
        createdBy: true,
        folderId: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listFolders() {
    const folders = await this.prisma.surveyFolder.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { surveys: { where: { isDeleted: false } } } } },
    });
    const unclassifiedCount = await this.prisma.survey.count({
      where: { isDeleted: false, folderId: null },
    });
    return { folders, unclassifiedCount };
  }

  async createFolder(adminId: number, name: string) {
    if (!name?.trim()) throw new BadRequestException('文件夹名称不能为空');
    return this.prisma.surveyFolder.create({ data: { name: name.trim(), createdBy: adminId } });
  }

  async updateFolder(id: number, name: string) {
    if (!name?.trim()) throw new BadRequestException('文件夹名称不能为空');
    return this.prisma.surveyFolder.update({ where: { id }, data: { name: name.trim() } });
  }

  async deleteFolder(id: number) {
    await this.prisma.survey.updateMany({ where: { folderId: id }, data: { folderId: null } });
    await this.prisma.surveyFolder.delete({ where: { id } });
    return { ok: true };
  }

  async moveSurveyToFolder(surveyId: number, folderId: number | null) {
    return this.prisma.survey.update({ where: { id: surveyId }, data: { folderId: folderId ?? null } });
  }

  async listWhitelists() {
    const whitelists = await this.prisma.surveyWhitelist.findMany({
      include: { survey: true, members: true },
      orderBy: { updatedAt: 'desc' },
    });
    return whitelists
      .filter((item) => !item.survey.isDeleted)
      .map((item) => ({
        id: item.id,
        surveyId: item.surveyId,
        enabled: item.enabled,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        memberCount: item.members.length,
        survey: item.survey,
      }));
  }

  async getWhitelist(surveyId: number) {
    const whitelist = await this.prisma.surveyWhitelist.findUnique({
      where: { surveyId },
      include: {
        survey: true,
        members: { include: { contact: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!whitelist || whitelist.survey.isDeleted) throw new NotFoundException('白名单不存在');
    return {
      id: whitelist.id,
      surveyId: whitelist.surveyId,
      enabled: whitelist.enabled,
      createdAt: whitelist.createdAt,
      updatedAt: whitelist.updatedAt,
      survey: whitelist.survey,
      members: whitelist.members.map((item) => item.contact),
    };
  }

  async createWhitelist(adminId: number, data: { surveyId: number; enabled?: boolean; memberContactIds?: number[] }) {
    const surveyId = Number(data.surveyId);
    await this.getAdminSurvey(surveyId);
    const exists = await this.prisma.surveyWhitelist.findUnique({ where: { surveyId } });
    if (exists) throw new ConflictException('该问卷已配置白名单，请通过编辑入口更新');

    const memberContactIds = this.uniqueIds(data.memberContactIds || []);
    await this.assertContactsExist(memberContactIds);

    const whitelist = await this.prisma.$transaction(async (tx) => {
      const created = await tx.surveyWhitelist.create({
        data: {
          surveyId,
          enabled: data.enabled ?? true,
          createdBy: adminId,
        },
      });
      if (memberContactIds.length > 0) {
        await tx.whitelistMember.createMany({
          data: memberContactIds.map((contactId) => ({ whitelistId: created.id, contactId })),
          skipDuplicates: true,
        });
      }
      return created;
    });
    return this.getWhitelist(whitelist.surveyId);
  }

  async updateWhitelist(surveyId: number, data: { enabled?: boolean; memberContactIds?: number[] }) {
    await this.getAdminSurvey(surveyId);
    const whitelist = await this.prisma.surveyWhitelist.findUnique({ where: { surveyId } });
    if (!whitelist) throw new NotFoundException('白名单不存在');

    const memberContactIds = this.uniqueIds(data.memberContactIds || []);
    await this.assertContactsExist(memberContactIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.surveyWhitelist.update({ where: { surveyId }, data: { enabled: data.enabled ?? true } });
      await tx.whitelistMember.deleteMany({ where: { whitelistId: whitelist.id } });
      if (memberContactIds.length > 0) {
        await tx.whitelistMember.createMany({
          data: memberContactIds.map((contactId) => ({ whitelistId: whitelist.id, contactId })),
          skipDuplicates: true,
        });
      }
    });
    return this.getWhitelist(surveyId);
  }

  async deleteWhitelist(surveyId: number) {
    const whitelist = await this.prisma.surveyWhitelist.findUnique({ where: { surveyId } });
    if (!whitelist) throw new NotFoundException('白名单不存在');
    await this.prisma.surveyWhitelist.delete({ where: { surveyId } });
    return { ok: true };
  }

  async matchWhitelistCsv(rows: Array<{ name?: string; phone?: string }>) {
    const normalizedRows = rows
      .map((row) => ({ name: String(row.name || '').trim(), phone: String(row.phone || '').trim() }))
      .filter((row) => row.name || row.phone);
    const phones = Array.from(new Set(normalizedRows.map((row) => row.phone).filter(Boolean)));
    const contacts = await this.prisma.contact.findMany({ where: { phone: { in: phones } } });
    const contactByPhone = new Map(contacts.map((contact) => [contact.phone, contact]));
    const matched: Array<{ contactId: number; name: string; phone: string; department: string | null }> = [];
    const unmatched: Array<{ name: string; phone: string; reason: string }> = [];
    const seenContactIds = new Set<number>();

    for (const row of normalizedRows) {
      if (!/^1\d{10}$/.test(row.phone)) {
        unmatched.push({ ...row, reason: '手机号格式错误' });
        continue;
      }
      const contact = contactByPhone.get(row.phone);
      if (!contact) {
        unmatched.push({ ...row, reason: '联系人中未找到' });
        continue;
      }
      if (!seenContactIds.has(contact.id)) {
        matched.push({ contactId: contact.id, name: contact.name, phone: contact.phone, department: contact.department });
        seenContactIds.add(contact.id);
      }
    }

    return { total: normalizedRows.length, matched, unmatched };
  }

  async getAdminSurvey(id: number) {
    const survey = await this.prisma.survey.findFirst({ where: { id, isDeleted: false } });
    if (!survey) throw new NotFoundException('问卷不存在');
    return survey;
  }

  async createSurvey(adminId: number, data: any) {
    const surveyType = data.type || SurveyType.assessment;
    try {
      return await this.prisma.survey.create({
        data: {
          title: data.title,
          type: surveyType,
          schemaJson: this.normalizeSchema(data.schemaJson, surveyType),
          status: SurveyStatus.draft,
          shareToken: randomBytes(16).toString('hex'),
          createdBy: adminId,
        },
      });
    } catch (error) {
      this.handleSurveyWriteError(error);
    }
  }

  async updateSurvey(id: number, data: any) {
    await this.getAdminSurvey(id);
    try {
      return await this.prisma.survey.update({
        where: { id },
        data: {
          title: data.title,
          type: data.type,
          schemaJson: this.normalizeSchema(data.schemaJson, data.type),
        },
      });
    } catch (error) {
      this.handleSurveyWriteError(error);
    }
  }

  async publishSurvey(id: number) {
    await this.getAdminSurvey(id);
    return this.prisma.survey.update({ where: { id }, data: { status: SurveyStatus.published } });
  }

  async setSurveyStatus(id: number, status: SurveyStatus) {
    await this.getAdminSurvey(id);
    return this.prisma.survey.update({ where: { id }, data: { status } });
  }

  async deleteSurvey(id: number) {
    await this.getAdminSurvey(id);
    await this.prisma.survey.update({ where: { id }, data: { isDeleted: true, status: SurveyStatus.disabled } });
    return { ok: true };
  }

  // ── 企微 OAuth ──

  async getWecomOAuthUrl(state: string): Promise<string> {
    const corpId = process.env.WECOM_CORP_ID || '';
    const agentId = process.env.WECOM_AGENT_ID || '';
    const redirectUri = encodeURIComponent(process.env.WECOM_CALLBACK_URL || 'https://hr.mmcb.top/api/wecom/oauth/callback');
    const encodedState = encodeURIComponent(state);
    return `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=${corpId}&agentid=${agentId}&redirect_uri=${redirectUri}&state=${encodedState}`;
  }

  async handleWecomCallback(code: string): Promise<{ token: string; name: string }> {
    const corpId = process.env.WECOM_CORP_ID || '';
    const secret = process.env.WECOM_APP_SECRET || '';

    // 1. 获取 access_token
    const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
    const tokenData: any = await tokenRes.json();
    if (tokenData.errcode !== 0) throw new UnauthorizedException(`企微授权失败: ${tokenData.errmsg}`);
    const accessToken: string = tokenData.access_token;

    // 2. 用 code 换取企微 userid
    const userInfoRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${accessToken}&code=${code}`);
    const userInfoData: any = await userInfoRes.json();
    if (userInfoData.errcode !== 0) throw new UnauthorizedException(`获取用户信息失败: ${userInfoData.errmsg}`);
    const wecomUserid: string = userInfoData.UserId || userInfoData.userid || '';
    if (!wecomUserid) throw new UnauthorizedException('未获取到企微用户ID');

    // 3. 获取用户详情（姓名、手机号）
    const userRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${accessToken}&userid=${wecomUserid}`);
    const userData: any = await userRes.json();
    const name: string = userData.name || '';
    const mobile: string = userData.mobile || '';

    // 4. 同步 WecomUser 记录
    const deptId = Array.isArray(userData.department) && userData.department.length > 0
      ? String(userData.department[0]) : null;
    await this.prisma.wecomUser.upsert({
      where: { wecomUserid },
      create: { wecomUserid, name, department: deptId },
      update: { name, department: deptId },
    });

    // 5. 匹配联系人（手机号优先，姓名兜底）
    const orConditions: any[] = [];
    if (mobile) orConditions.push({ phone: mobile });
    if (name) orConditions.push({ name });
    if (orConditions.length === 0) throw new ForbiddenException('您不在系统联系人名单中');

    const contact = await this.prisma.contact.findFirst({ where: { OR: orConditions } });
    if (!contact) throw new ForbiddenException('您不在系统联系人名单中，请联系管理员');

    // 6. 签发填写端 JWT（24h 有效）
    const token = this.jwt.sign(
      { sub: contact.id, wecomUserid, name: contact.name, type: 'fill' },
      { expiresIn: '24h' },
    );
    return { token, name: contact.name };
  }

  // ── 公开问卷 ──

  // 每人每卷最多提交 2 次（1 次初填 + 1 次修改）。仅统计普通填写记录（rateeContactId=null），
  // 与 360 环评的答卷（rateeContactId 非空）隔离，互不干扰。
  // ── 我的问卷（企微内「我的问卷」页数据源）──
  // 待填写：已发布 + 可填类 + 白名单(enabled)包含当前用户 + 尚未填写
  // 已填写：当前用户全部普通答卷对应的问卷，不受白名单限制（覆盖二维码分发、无白名单的问卷）
  async getMySurveys(fillUser: FillUser) {
    const contactId = fillUser.sub;
    const wecomUserid = fillUser.wecomUserid;

    const responses = await this.prisma.surveyResponse.findMany({
      where: { wecomUserid, rateeContactId: null },
      include: { survey: true },
      orderBy: [{ updatedAt: 'desc' }, { submittedAt: 'desc' }],
    });

    const filledSurveyIds = new Set<number>();
    const filled: any[] = [];
    for (const r of responses) {
      const s = r.survey;
      if (!s || s.isDeleted || s.type === SurveyType.promotional_document) continue;
      if (filledSurveyIds.has(s.id)) continue; // 每卷仅取最新一条
      filledSurveyIds.add(s.id);
      const edited = r.submitCount >= 2;
      filled.push({
        id: s.id,
        shareToken: s.shareToken,
        title: s.title,
        type: s.type,
        status: s.status,
        submitCount: r.submitCount,
        canEdit: r.submitCount < 2,
        finishedAt: edited ? r.updatedAt : r.submittedAt,
      });
    }

    const whitelists = await this.prisma.surveyWhitelist.findMany({
      where: {
        enabled: true,
        members: { some: { contactId } },
        survey: {
          isDeleted: false,
          status: SurveyStatus.published,
          type: { in: [SurveyType.assessment, SurveyType.case_collection] },
        },
      },
      include: { survey: true },
    });

    const pending = whitelists
      .filter((w) => w.survey && !filledSurveyIds.has(w.surveyId))
      .sort((a, b) => b.survey.updatedAt.getTime() - a.survey.updatedAt.getTime())
      .map((w) => ({
        id: w.survey.id,
        shareToken: w.survey.shareToken,
        title: w.survey.title,
        type: w.survey.type,
        status: w.survey.status,
      }));

    return { user: { name: fillUser.name }, pending, filled };
  }

  private findOwnResponse(surveyId: number, wecomUserid: string) {
    return this.prisma.surveyResponse.findFirst({
      where: { surveyId, wecomUserid, rateeContactId: null },
      orderBy: { submittedAt: 'desc' },
    });
  }

  // 宣传文档类免登录直看：任何人凭 shareToken 即可查看已发布的宣传文档（跳过白名单与企微登录）。
  // 其它类型返回 { requiresAuth: true }，由前端再走企微授权流程。
  async getPublicDoc(shareToken: string) {
    const survey = await this.prisma.survey.findUnique({ where: { shareToken } });
    if (!survey || survey.isDeleted) throw new NotFoundException('问卷不存在或已下线');
    if (survey.status !== SurveyStatus.published) throw new ForbiddenException('该问卷暂未开放');
    if (survey.type !== SurveyType.promotional_document) {
      return { requiresAuth: true as const };
    }
    return { ...survey, requiresAuth: false as const };
  }

  async getPublicSurvey(shareToken: string, fillUser: FillUser) {
    const survey = await this.prisma.survey.findUnique({ where: { shareToken } });
    if (!survey || survey.isDeleted) throw new NotFoundException('问卷不存在或已下线');
    if (survey.status !== SurveyStatus.published) throw new ForbiddenException('该问卷暂未开放');
    await this.ensureWhitelistAccess(survey.id, fillUser);

    const currentUser = { wecomUserid: fillUser.wecomUserid, name: fillUser.name };
    const existing = await this.findOwnResponse(survey.id, fillUser.wecomUserid);
    const submission = existing
      ? {
          submitted: true,
          canEdit: existing.submitCount < 2, // 还剩一次修改机会
          submitCount: existing.submitCount,
          answers: existing.answersJson,
          submittedAt: existing.submittedAt,
          updatedAt: existing.updatedAt,
        }
      : { submitted: false, canEdit: false, submitCount: 0, answers: null, submittedAt: null, updatedAt: null };
    return { ...survey, currentUser, submission, alreadySubmitted: submission.submitted };
  }

  async submitSurvey(shareToken: string, answersJson: Record<string, unknown>, fillUser: FillUser) {
    const survey = await this.getPublicSurvey(shareToken, fillUser);
    if (survey.type === SurveyType.promotional_document) {
      throw new BadRequestException('宣传文档类不支持提交答卷');
    }
    this.validateAnswers(survey.schemaJson as SurveySchema, answersJson);

    const existing = await this.findOwnResponse(survey.id, fillUser.wecomUserid);

    // 初次提交
    if (!existing) {
      return this.prisma.surveyResponse.create({
        data: {
          surveyId: survey.id,
          wecomUserid: fillUser.wecomUserid,
          answersJson: answersJson as Prisma.InputJsonValue,
          submitCount: 1,
        },
      });
    }

    // 修改机会已用完
    if (existing.submitCount >= 2) {
      throw new ForbiddenException('您已完成问卷填写，修改次数已用完');
    }

    // 唯一一次修改：原地覆盖答案，管理员始终只看到每人一份最终结果
    return this.prisma.surveyResponse.update({
      where: { id: existing.id },
      data: {
        answersJson: answersJson as Prisma.InputJsonValue,
        submitCount: existing.submitCount + 1,
      },
    });
  }

  // ── 数据汇总（白名单 = 应填名册；方案A：以"企微姓名 = 联系人姓名"联结）──

  async getSurveySummary(surveyId: number) {
    const survey = await this.getAdminSurvey(surveyId);

    // 名册 = 白名单成员（联系人）
    const whitelist = await this.prisma.surveyWhitelist.findUnique({
      where: { surveyId },
      include: { members: { include: { contact: true }, orderBy: { createdAt: 'asc' } } },
    });
    const roster = whitelist ? whitelist.members.map((m) => m.contact) : [];
    const hasWhitelist = roster.length > 0; // 决策：仅"有成员"才算配置了名册

    // 普通填写答卷（rateeContactId=null，与 360 环评隔离）
    const responses = await this.prisma.surveyResponse.findMany({
      where: { surveyId, rateeContactId: null },
      orderBy: { submittedAt: 'desc' },
    });
    const users = await this.prisma.wecomUser.findMany({
      where: { wecomUserid: { in: responses.map((r) => r.wecomUserid) } },
    });
    const nameByWecom = new Map(users.map((u) => [u.wecomUserid, u.name]));

    // 最终提交时间：改过取 updatedAt，否则取 submittedAt（避免历史数据 updatedAt 被迁移回填干扰）
    const filledAtOf = (r: any) => (r.submitCount >= 2 ? r.updatedAt : r.submittedAt);

    // 每个填写人姓名取最新一条（responses 已按 submittedAt desc）
    const latestByName = new Map<string, any>();
    const noNameResponses: any[] = [];
    for (const r of responses) {
      const nm = nameByWecom.get(r.wecomUserid);
      if (!nm) {
        noNameResponses.push(r);
        continue;
      }
      if (!latestByName.has(nm)) latestByName.set(nm, r);
    }

    let rows: any[] = [];
    const outsiders: any[] = [];

    if (hasWhitelist) {
      const consumed = new Set<string>();
      rows = roster.map((c) => {
        const r = latestByName.get(c.name);
        if (r) consumed.add(c.name);
        return {
          contactId: c.id,
          name: c.name,
          department: c.department,
          jobNo: c.jobNo,
          submitted: !!r,
          edited: r ? r.submitCount >= 2 : false,
          filledAt: r ? filledAtOf(r) : null,
          responseId: r?.id ?? null,
        };
      });
      // 名单外：填了但不在名册
      for (const [nm, r] of latestByName) {
        if (consumed.has(nm)) continue;
        outsiders.push({ name: nm, wecomUserid: r.wecomUserid, filledAt: filledAtOf(r), responseId: r.id, edited: r.submitCount >= 2 });
      }
      for (const r of noNameResponses) {
        outsiders.push({ name: null, wecomUserid: r.wecomUserid, filledAt: filledAtOf(r), responseId: r.id, edited: r.submitCount >= 2 });
      }
    } else {
      // 无名册：仅展示已填写人（每个姓名一行，无企微姓名的用 wecomUserid 兜底）
      const seen = new Set<string>();
      for (const r of responses) {
        const nm = nameByWecom.get(r.wecomUserid);
        const key = nm ?? `wx:${r.wecomUserid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          contactId: null,
          name: nm ?? r.wecomUserid,
          department: null,
          jobNo: null,
          submitted: true,
          edited: r.submitCount >= 2,
          filledAt: filledAtOf(r),
          responseId: r.id,
        });
      }
    }

    // 决策：默认按填写时间倒序，未填排最后
    rows.sort((a, b) => {
      if (!a.filledAt && !b.filledAt) return 0;
      if (!a.filledAt) return 1;
      if (!b.filledAt) return -1;
      return new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime();
    });

    const total = hasWhitelist ? roster.length : rows.length;
    const submitted = rows.filter((r) => r.submitted).length;
    const unsubmitted = Math.max(0, total - submitted);
    const rate = total === 0 ? 1 : submitted / total;

    return {
      survey: { id: survey.id, title: survey.title, type: survey.type },
      hasWhitelist,
      summary: { total, submitted, unsubmitted, rate },
      rows,
      outsiders,
    };
  }

  async exportSurveySummary(surveyId: number) {
    const data = await this.getSurveySummary(surveyId);
    const fmt = (t: any) => (t ? new Date(t).toLocaleString('zh-CN') : '');
    const rosterRows = data.rows.map((r: any) => ({
      姓名: r.name,
      部门: r.department || '',
      工号: r.jobNo || '',
      填写情况: r.submitted ? '已填' : '未填',
      填写时间: fmt(r.filledAt),
      是否修改: r.submitted ? (r.edited ? '是' : '否') : '',
    }));
    const outsiderRows = data.outsiders.map((o: any) => ({
      姓名: o.name || o.wecomUserid,
      部门: '（名单外）',
      工号: '',
      填写情况: '已填',
      填写时间: fmt(o.filledAt),
      是否修改: o.edited ? '是' : '否',
    }));
    return stringify([...rosterRows, ...outsiderRows], { header: true, bom: true });
  }

  async listResponses(surveyId: number, startDate?: Date, endDate?: Date) {
    await this.getAdminSurvey(surveyId);
    const dateFilter: any = {};
    if (startDate) dateFilter.gte = startDate;
    if (endDate) {
      // endDate 取当天结束（23:59:59.999）
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.lte = end;
    }
    const responses = await this.prisma.surveyResponse.findMany({
      where: {
        surveyId,
        ...(Object.keys(dateFilter).length > 0 ? { submittedAt: dateFilter } : {}),
      },
      include: { comment: true },
      orderBy: { submittedAt: 'desc' },
    });
    const users = await this.prisma.wecomUser.findMany({
      where: { wecomUserid: { in: responses.map((item) => item.wecomUserid) } },
    });
    const userMap = new Map(users.map((item) => [item.wecomUserid, item]));
    return responses.map((item) => ({ ...item, wecomUser: userMap.get(item.wecomUserid) || null }));
  }

  async commentResponse(adminId: number, responseId: number, data: { comment?: string; score?: number }) {
    if (data.score && (data.score < 1 || data.score > 10)) {
      throw new BadRequestException('评分范围为 1~10');
    }
    return this.prisma.responseComment.create({
      data: {
        responseId,
        adminId,
        comment: data.comment || '',
        score: data.score,
      },
    });
  }

  async exportSurvey(surveyId: number, startDate?: Date, endDate?: Date) {
    const survey = await this.getAdminSurvey(surveyId);

    if (survey.type === SurveyType.promotional_document) {
      return stringify(
        [{ 标题: survey.title, 类型: '宣传文档类', 内容HTML: (survey.schemaJson as SurveySchema).contentHtml || '' }],
        { header: true, bom: true },
      );
    }

    const responses = await this.listResponses(surveyId, startDate, endDate);
    const contacts = await this.prisma.contact.findMany();
    const contactMap = new Map(contacts.map((item) => [item.name, item]));
    const questions = ((survey.schemaJson as SurveySchema).questions || []) as SurveyQuestion[];
    const rows = responses.map((item: any) => {
      const name = item.wecomUser?.name || '';
      const contact = contactMap.get(name);
      const base: Record<string, unknown> = {
        提交人企微姓名: name,
        关联联系人工号: contact?.jobNo || '',
        关联联系人部门: contact?.department || '',
        提交时间: item.submittedAt.toISOString(),
      };
      let qNo = 0;
      for (const question of questions) {
        if (question.type === 'description') continue;
        qNo++;
        const value = (item.answersJson || {})[question.id];
        const colKey = `Q${qNo}_${question.label}`;
        base[colKey] = Array.isArray(value) ? value.join('、') : value || '';
      }
      base.点评内容 = item.comment?.comment || '';
      base.评分 = item.comment?.score || '';
      return base;
    });
    return stringify(rows, { header: true, bom: true });
  }

  private normalizeSchema(schemaJson: SurveySchema | undefined, surveyType: SurveyType): SurveySchema {
    if (surveyType === SurveyType.promotional_document) {
      return {
        questions: [],
        contentHtml: typeof schemaJson?.contentHtml === 'string' ? schemaJson.contentHtml : '',
      };
    }

    if (!schemaJson || !Array.isArray(schemaJson.questions)) return emptySurveySchema;
    return {
      questions: schemaJson.questions.map((question, index) => ({
        id: question.id || `q${index + 1}`,
        type: question.type,
        label: question.type === 'description' ? question.description || question.label : question.label,
        description: question.description || '',
        required: question.type === 'description' ? false : Boolean(question.required),
        options: question.type === 'description' ? [] : question.options || [],
        maxScore: question.type === 'rating' ? 10 : question.maxScore,
        maxSizeMB: question.type === 'file' ? 20 : question.maxSizeMB,
        accept: question.type === 'file' ? ['.jpg', '.png', '.pdf', '.doc', '.docx', '.xlsx'] : question.accept,
        visibleWhen: question.visibleWhen,
        hasOther: ['radio', 'checkbox'].includes(question.type) ? Boolean(question.hasOther) : undefined,
      })),
      contentHtml: '',
    };
  }

  private validateAnswers(schema: SurveySchema, answers: Record<string, unknown>) {
    for (const question of schema.questions || []) {
      if (!this.isVisible(question, answers)) continue;
      if (question.type === 'description') continue;
      const value = answers[question.id];
      if (
        question.required &&
        (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0))
      ) {
        throw new BadRequestException(`请填写：${question.label}`);
      }
      if (question.type === 'rating' && value !== undefined && value !== null && value !== '') {
        const score = Number(value);
        const maxScore = question.maxScore || 10;
        if (!Number.isInteger(score) || score < 1 || score > maxScore) {
          throw new BadRequestException(`${question.label} 的评分范围为 1~${maxScore}`);
        }
      }
    }
  }

  private isVisible(question: SurveyQuestion, answers: Record<string, unknown>) {
    if (!question.visibleWhen) return true;
    const parent = answers[question.visibleWhen.questionId];
    if (Array.isArray(parent)) {
      return parent.some((item) => question.visibleWhen?.valueIn.includes(String(item)));
    }
    return question.visibleWhen.valueIn.includes(String(parent));
  }

  private contactData(data: any, required = false) {
    const name = String(data.name || '').trim();
    const phone = String(data.phone || '').trim();
    if (required && !name) throw new BadRequestException('请输入姓名');
    if (required && !phone) throw new BadRequestException('请输入手机号');

    return {
      name,
      department: data.department || null,
      jobNo: data.jobNo || null,
      position: data.position || null,
      phone,
      email: data.email || null,
      tags: data.tags || null,
    };
  }

  private handleSurveyWriteError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('问卷名称已存在，请更换名称后再保存');
    }
    throw error;
  }

  private publicAdmin(admin: any) {
    return {
      id: admin.id,
      name: admin.name,
      phone: admin.phone,
      isPrimary: admin.isPrimary,
      createdAt: admin.createdAt,
    };
  }

  private async ensureWhitelistAccess(surveyId: number, fillUser: FillUser) {
    const whitelist = await this.prisma.surveyWhitelist.findUnique({
      where: { surveyId },
      include: { members: true },
    });
    if (!whitelist || !whitelist.enabled) return;

    const allowed = whitelist.members.some((member) => member.contactId === fillUser.sub);
    if (!allowed) throw new ForbiddenException('该问卷暂未开放');
  }

  private uniqueIds(ids: number[]) {
    return Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  }

  private async assertContactsExist(contactIds: number[]) {
    if (contactIds.length === 0) return;
    const count = await this.prisma.contact.count({ where: { id: { in: contactIds } } });
    if (count !== contactIds.length) throw new BadRequestException('白名单成员中包含不存在的联系人');
  }
}
