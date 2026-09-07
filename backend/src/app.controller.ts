import { BadRequestException, Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SurveyStatus, SurveyType } from '@prisma/client';
import { diskStorage, memoryStorage } from 'multer';
import { extname } from 'path';
import type { Response } from 'express';
import { AdminAuthGuard } from './admin-auth.guard';
import { FillAuthGuard } from './fill-auth.guard';
import { AppService } from './app.service';
import { OrganizationService } from './organization.service';
import { OrganizationWorkbookService } from './organization-workbook.service';

@Controller('api')
export class AppController {
  constructor(
    private readonly app: AppService,
    private readonly organization: OrganizationService,
    private readonly organizationWorkbook: OrganizationWorkbookService,
  ) {}

  @Get('health')
  health() {
    return this.app.health();
  }

  @Post('admin/auth/login')
  login(@Body() body: any) {
    return this.app.login(body.phone, body.password);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/members')
  listMembers() {
    return this.app.listMembers();
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/members')
  createMember(@Body() body: any) {
    return this.app.createMember(body);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/members/:id')
  deleteMember(@Param('id', ParseIntPipe) id: number) {
    return this.app.deleteMember(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/contacts')
  listContacts(
    @Query('q') q?: string,
    @Query('departmentId') departmentId?: string,
    @Query('membershipType') membershipType?: 'primary' | 'secondary' | 'all',
    @Query('status') status?: 'active' | 'inactive' | 'all',
  ) {
    return this.organization.listContacts({
      q,
      departmentId: departmentId ? Number(departmentId) : undefined,
      membershipType,
      status,
    });
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/contacts')
  createContact(@Body() body: any) {
    return this.organization.createContact(body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/contacts/:id')
  updateContact(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.organization.updateContact(id, body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/contacts/:id/status')
  setContactStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('isActive') isActive: boolean,
  ) {
    return this.organization.setContactStatus(id, Boolean(isActive));
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/contacts/:id')
  deleteContact(@Param('id', ParseIntPipe) id: number) {
    return this.organization.deleteContact(id);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/contacts/import')
  importContacts(@Body() body: any, @Query('dryRun') dryRun?: string) {
    return this.organization.importContacts(
      body.rows || [],
      dryRun === 'true',
    );
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/contacts/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportContacts(@Res() res: Response) {
    res
      .attachment('contacts.csv')
      .send(await this.organization.exportContactsCsv());
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/org/departments/tree')
  listDepartmentTree() {
    return this.organization.listDepartmentTree();
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/org/departments')
  createDepartment(@Body() body: any) {
    return this.organization.createDepartment(body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/org/departments/:id')
  updateDepartment(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.organization.updateDepartment(id, body);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/org/departments/:id/move')
  moveDepartment(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.organization.moveDepartment(id, body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/org/departments/:id/status')
  setDepartmentStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('isActive') isActive: boolean,
  ) {
    return this.organization.setDepartmentStatus(id, Boolean(isActive));
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/org/departments/:id')
  deleteDepartment(@Param('id', ParseIntPipe) id: number) {
    return this.organization.deleteDepartment(id);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/org/import/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  previewOrganizationWorkbook(@UploadedFile() file: Express.Multer.File) {
    return this.organizationWorkbook.previewWorkbook(file);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/org/import/apply')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  applyOrganizationWorkbook(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    let selectedIds: unknown = [];
    try {
      selectedIds = JSON.parse(String(body?.selectedIds || '[]'));
    } catch {
      throw new BadRequestException('确认项格式不正确');
    }
    return this.organizationWorkbook.applyWorkbookSelection(file, {
      fileHash: body?.fileHash,
      baselineHash: body?.baselineHash,
      selectedIds,
    });
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/org/import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  importOrganizationWorkbook(
    @UploadedFile() file: Express.Multer.File,
    @Query('dryRun') dryRun?: string,
  ) {
    return this.organizationWorkbook.importWorkbook(file, dryRun === 'true');
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/org/export')
  async exportOrganizationWorkbook(@Res() res: Response) {
    res
      .attachment('organization-contacts.xlsx')
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(await this.organizationWorkbook.exportWorkbook());
  }


  @UseGuards(AdminAuthGuard)
  @Get('admin/folders')
  listFolders() {
    return this.app.listFolders();
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/folders')
  createFolder(@Req() req: any, @Body('name') name: string) {
    return this.app.createFolder(req.admin.sub, name);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/folders/:id')
  updateFolder(@Param('id', ParseIntPipe) id: number, @Body('name') name: string) {
    return this.app.updateFolder(id, name);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/folders/:id')
  deleteFolder(@Param('id', ParseIntPipe) id: number) {
    return this.app.deleteFolder(id);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/surveys/:id/folder')
  moveSurveyToFolder(@Param('id', ParseIntPipe) id: number, @Body('folderId') folderId: number | null) {
    return this.app.moveSurveyToFolder(id, folderId ?? null);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys')
  listSurveys(@Query('keyword') keyword?: string, @Query('type') type?: SurveyType, @Query('folderId') folderId?: string) {
    const parsed = folderId === 'unclassified' ? 'unclassified' : folderId ? parseInt(folderId) : undefined;
    return this.app.listSurveys({ keyword, type, folderId: parsed as any });
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id')
  getAdminSurvey(@Param('id', ParseIntPipe) id: number) {
    return this.app.getAdminSurvey(id);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/surveys')
  createSurvey(@Req() req: any, @Body() body: any) {
    return this.app.createSurvey(req.admin.sub, body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/surveys/:id')
  updateSurvey(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.app.updateSurvey(id, body);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/surveys/:id/publish')
  publishSurvey(@Param('id', ParseIntPipe) id: number) {
    return this.app.publishSurvey(id);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/surveys/:id/status')
  setSurveyStatus(@Param('id', ParseIntPipe) id: number, @Body('status') status: SurveyStatus) {
    return this.app.setSurveyStatus(id, status);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/surveys/:id')
  deleteSurvey(@Param('id', ParseIntPipe) id: number) {
    return this.app.deleteSurvey(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id/responses')
  listResponses(@Param('id', ParseIntPipe) id: number) {
    return this.app.listResponses(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id/summary')
  getSurveySummary(@Param('id', ParseIntPipe) id: number) {
    return this.app.getSurveySummary(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id/summary/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportSurveySummary(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    res.attachment(`survey-${id}-roster.csv`).send(await this.app.exportSurveySummary(id));
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportSurvey(
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate: string | undefined,
    @Query('endDate') endDate: string | undefined,
    @Res() res: Response,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    res.attachment(`survey-${id}.csv`).send(await this.app.exportSurvey(id, start, end));
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/whitelists')
  listWhitelists() {
    return this.app.listWhitelists();
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/whitelists/match-csv')
  matchWhitelistCsv(@Body() body: any) {
    return this.app.matchWhitelistCsv(body.rows || []);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/whitelists')
  createWhitelist(@Req() req: any, @Body() body: any) {
    return this.app.createWhitelist(req.admin.sub, body);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/whitelists/:surveyId')
  getWhitelist(@Param('surveyId', ParseIntPipe) surveyId: number) {
    return this.app.getWhitelist(surveyId);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/whitelists/:surveyId')
  updateWhitelist(@Param('surveyId', ParseIntPipe) surveyId: number, @Body() body: any) {
    return this.app.updateWhitelist(surveyId, body);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/whitelists/:surveyId')
  deleteWhitelist(@Param('surveyId', ParseIntPipe) surveyId: number) {
    return this.app.deleteWhitelist(surveyId);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/responses/:id/comment')
  commentResponse(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.app.commentResponse(req.admin.sub, id, body);
  }

  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(file.originalname)}`),
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    return { url: `/uploads/${file.filename}` };
  }

  @Get('wecom/oauth/url')
  async wecomUrl(@Query('state') state: string, @Res() res: Response) {
    const url = await this.app.getWecomOAuthUrl(state || '/');
    res.redirect(302, url);
  }

  @Get('wecom/oauth/callback')
  async wecomCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const backTo = state || '/';
    const base = (process.env.WECOM_CALLBACK_URL?.replace(/\/api\/wecom\/oauth\/callback$/, '') || process.env.FRONTEND_ORIGIN?.replace(/\/$/, '') || 'https://hr.mmcb.top');
    try {
      const { token } = await this.app.handleWecomCallback(code);
      const sep = backTo.includes('?') ? '&' : '?';
      res.redirect(302, `${base}${backTo}${sep}fill_token=${token}`);
    } catch (err: any) {
      const sep = backTo.includes('?') ? '&' : '?';
      res.redirect(302, `${base}${backTo}${sep}auth_error=${encodeURIComponent(err.message || '授权失败')}`);
    }
  }

  // 宣传文档类免登录直看（无 Guard）：宣传文档直接返回内容，其它类型返回 { requiresAuth: true }
  @Get('survey/:shareToken/public')
  getPublicDoc(@Param('shareToken') shareToken: string) {
    return this.app.getPublicDoc(shareToken);
  }

  // 免登录（外部）问卷提交（无 Guard）：仅对 publicFill=true 的问卷放行
  @Post('survey/:shareToken/public-submit')
  submitPublicSurvey(@Param('shareToken') shareToken: string, @Body('answers') answers: Record<string, unknown>) {
    return this.app.submitPublicSurvey(shareToken, answers || {});
  }

  @UseGuards(FillAuthGuard)
  @Get('survey/:shareToken')
  getPublicSurvey(@Param('shareToken') shareToken: string, @Req() req: any) {
    return this.app.getPublicSurvey(shareToken, req.fillUser);
  }

  @UseGuards(FillAuthGuard)
  @Post('survey/:shareToken/submit')
  submitSurvey(@Param('shareToken') shareToken: string, @Body('answers') answers: Record<string, unknown>, @Req() req: any) {
    return this.app.submitSurvey(shareToken, answers || {}, req.fillUser);
  }

  @UseGuards(FillAuthGuard)
  @Get('my/surveys')
  getMySurveys(@Req() req: any) {
    return this.app.getMySurveys(req.fillUser);
  }
}
