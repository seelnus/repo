# 闯货内部问卷管理系统

企业内部调研与考核平台，支持多类型问卷创建、白名单管控、企微 OAuth 授权填写、数据统计与导出。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 · Vite · TypeScript · Ant Design |
| 后端 | NestJS · Prisma ORM · JWT 鉴权 |
| 数据库 | MySQL 8.0 |
| 存储 | 本地上传目录（MinIO 已预留） |
| 部署 | Docker Compose · Nginx 反向代理 |

## 功能模块

- **问卷管理**：支持问卷考核、案例收集、宣传文档三种类型，包含单选、多选、评分、文本、附件、日期等题型，支持题目显示条件逻辑
- **白名单管控**：为问卷配置可填写的人员名单，支持手动选择或 CSV 批量导入
- **联系人管理**：维护员工通讯录，支持 CSV 导入导出
- **后台成员**：多账号管理，支持新增和删除成员
- **数据统计**：查看提交记录、逐题答案、管理员点评评分，一键导出 CSV
- **企微 OAuth**：填写端通过企业微信授权身份，开发环境使用 mock 用户

## 本地开发

**前置条件**：Node.js 20+、Docker

### 1. 配置环境变量

```bash
cp .env.example .env
```

`.env` 关键字段说明：

```env
DATABASE_URL        # MySQL 连接串
JWT_SECRET          # JWT 签名密钥，生产环境务必替换
FRONTEND_ORIGIN     # 前端地址，用于 CORS
SEED_ADMIN_PHONE    # 初始管理员手机号
SEED_ADMIN_PASSWORD # 初始管理员密码
WECOM_CORP_ID       # 企微 CorpID（可选，留空使用 mock 用户）
```

### 2. 启动服务

```bash
docker compose up --build
```

启动后：
- 前端：http://localhost:5174
- 后端：http://localhost:3100/api/health
- 数据库：localhost:3306

### 3. 单独启动（不用 Docker）

```bash
# 启动 MySQL
docker compose up mysql -d

# 后端
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run start:dev

# 前端（新开终端）
cd frontend
npm install
npm run dev
```

默认管理员账号：
- 手机号：`13800000000`
- 密码：`admin123456`

## 数据库模型

```
AdminUser        后台管理员
Contact          联系人（员工通讯录）
WecomUser        企微用户（填写端身份）
Survey           问卷
SurveyWhitelist  问卷白名单配置
WhitelistMember  白名单成员
SurveyResponse   问卷提交记录
ResponseComment  管理员点评
```

## 生产部署

项目已部署至：**https://hr.mmcb.top**

### 服务器环境

- 阿里云 ECS · IP：`47.97.80.44`
- 宝塔面板 + Docker 26.1.3
- Nginx 反向代理（宝塔管理）
- SSL 证书：Let's Encrypt，到期 2026-09-23

### 部署流程

```bash
# 服务器上（/www/wwwroot/survey-app）
git pull
docker compose up -d --build
```

### 端口映射

| 服务 | 容器端口 | 宿主机端口 |
|------|---------|-----------|
| 前端 | 5174 | 8080 |
| 后端 | 3100 | 3100 |
| MySQL | 3306 | 不对外暴露 |

Nginx 统一从 443/80 → 前端 8080 / 后端 3100 做反向代理。

## 目录结构

```
.
├── backend/          NestJS 后端
│   ├── prisma/       数据库 Schema 与迁移
│   ├── src/          业务代码
│   └── uploads/      用户上传文件
├── frontend/         React 前端
│   ├── public/       静态资源（含 chuanghuo.png logo）
│   └── src/
│       ├── App.tsx   主应用（含所有页面组件）
│       └── index.css 全局样式
├── docker-compose.yml
└── .env.example
```

## 开发注意事项

- 企微 OAuth 在本地开发时使用 mock 用户（`mock-user-001` / `测试员工`），生产环境需配置 `WECOM_*` 环境变量
- 文件上传当前存储在容器本地 `backend/uploads`，重建容器前需确保 volume 挂载正确
- `JWT_SECRET` 包含特殊字符时需用引号包裹，避免 shell 解析问题
