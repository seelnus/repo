# 生产发布、备份与回滚脚本

这组脚本实现“发布前完整恢复点、统一发布、人工验收和完整回滚”。正式规则以
[`docs/superpowers/specs/2026-08-28-production-backup-rollback-design.md`](../../docs/superpowers/specs/2026-08-28-production-backup-rollback-design.md)
为准。

## 当前提供

- `preflight.sh`：检查 Git、Compose 服务、MySQL/Prisma、InnoDB、三个命名卷、权限、磁盘空间和历史备份哈希。
- `backup.sh`：停止后端和 MinIO 写入，备份数据库、uploads、MinIO、`.env`、Compose 配置和版本清单。
- `verify-backup.sh`：校验压缩包与 SHA-256，将 SQL 恢复到随机临时库，逐表核对精确行数与 Prisma 迁移。
- `release.sh`：在维护状态下串联备份、Git 切换、依赖安装、Prisma 迁移、服务启动和健康检查。
- `finalize-release.sh`：人工验收通过后，将本次恢复点标记为 `RELEASE_SUCCEEDED`。
- `rollback.sh`：按恢复点恢复 Git、配置、数据库、uploads 和 MinIO，并核对行数、迁移与健康状态。
- `list-backups.sh`：安全列出恢复点及校验状态，不输出环境密钥。
- `prune-backups.sh`：仅清理多于最近 2 个的 `RELEASE_SUCCEEDED` 恢复点。

发布脚本不会替代 Nginx 维护页。执行正式发布前，必须先确认公网请求无法产生新答卷或附件，再传入 `--maintenance-confirmed`。

## 前置条件

- Linux、Bash、Docker Compose v2、Git、Python 3、GNU `realpath`、`gzip`、`tar`、`sha256sum`、`flock`。Python 默认命令为 `python3`，可通过 `PYTHON_BIN` 覆盖。
- 当前 Compose 服务名为 `mysql`、`app-backend`、`minio`；可通过同名环境变量覆盖。
- MySQL 容器内存在 `MYSQL_ROOT_PASSWORD` 或 `MYSQL_ROOT_PASSWORD_FILE`。
- 辅助镜像 `node:20-alpine` 已存在；可用 `HELPER_IMAGE` 覆盖。
- 正式项目目录和备份根目录默认分别为 `/www/wwwroot/survey-app`、`/www/backup/survey-app`。

脚本不会把 MySQL 密码写入命令行或日志；`.env` 备份和整个恢复点目录权限均限制为仅所有者访问。

## 首次启用时的备份验证

先执行只读检查：

```bash
sudo bash scripts/prod/preflight.sh --target-ref <目标-git-ref> --dry-run
sudo bash scripts/prod/backup.sh --target-ref <目标-git-ref> --dry-run
```

单独创建并验证恢复点（验证结束会恢复旧后端和 MinIO）：

```bash
sudo bash scripts/prod/backup.sh --target-ref <目标-git-ref>
```

## 正式发布

先执行 dry-run：

```bash
sudo bash scripts/prod/release.sh \
  --target-ref <目标完整Git-SHA> \
  --dry-run
```

在宝塔/Nginx 启用维护页并确认外部无法提交后，执行：

```bash
sudo bash scripts/prod/release.sh \
  --target-ref <目标完整Git-SHA> \
  --confirm-target <目标完整Git-SHA> \
  --maintenance-confirmed
```

脚本成功后恢复点仍为 `VERIFIED`。保持维护页，完成管理员登录、普通问卷、360 环评、历史数据和附件的人工验收。验收通过后：

```bash
sudo bash scripts/prod/finalize-release.sh \
  --backup-id <本次发布输出的备份ID> \
  --confirm-backup-id <本次发布输出的备份ID>
```

只有看到 `STATUS=RELEASE_SUCCEEDED` 后才能关闭维护页。

## 回滚

先 dry-run：

```bash
sudo bash scripts/prod/rollback.sh \
  --backup-id <备份ID> \
  --dry-run
```

正式回滚会覆盖数据库和两个文件卷，必须再次输入或显式传入完整备份 ID：

```bash
sudo bash scripts/prod/rollback.sh \
  --backup-id <备份ID> \
  --confirm-backup-id <备份ID> \
  --reason '<回滚原因>'
```

普通人工回滚默认先创建“失败现场”恢复点。只有受控发布仍处于维护窗口时，`release.sh` 才会内部跳过这一步并自动恢复。

## 查看和滚动清理

列出备份：

```bash
sudo bash scripts/prod/list-backups.sh
```

预览滚动清理（默认即预览）：

```bash
sudo bash scripts/prod/prune-backups.sh --dry-run
```

只有新版本验收通过、对应恢复点已由发布流程标记为 `RELEASE_SUCCEEDED` 后，才允许：

```bash
sudo bash scripts/prod/prune-backups.sh --yes
```

## 恢复点内容

目录为 `/www/backup/survey-app/releases/<时间>_<Git短SHA>/`，包含：

- `database.sql.gz`
- `backend-uploads.tar.gz`
- `minio-data.tar.gz`
- `environment.env`
- `docker-compose.yml`
- `manifest.json`
- `row-counts.tsv`
- `migrations.tsv`
- `SHA256SUMS`
- `verify.log`
- `STATUS`

其中 `STATUS=VERIFIED` 只代表备份已恢复验证，不代表新版本发布成功。滚动清理只认 `RELEASE_SUCCEEDED`，因此不会在发布门禁尚未接入时误删恢复点。

## 安全限制

- 不使用 `docker compose down -v`，不直接操作或删除业务卷。
- 卷名从容器挂载动态解析；不是唯一命名卷时立即停止。
- 临时验证数据库名只允许脚本生成，退出时总会尝试删除。
- `prune-backups.sh` 必须同时满足固定 ID、根路径边界、合法清单、状态和哈希校验，且明确传入 `--yes` 才删除。
- 本地 ECS 备份不能防止 ECS 整机或云盘损坏。

## 隔离演练

测试只使用名称带 `prod-script-test-*` 或 `prod-release-*` 的隔离 Compose 项目和卷：

```bash
bash scripts/prod/tests/rollback-drill.sh
bash scripts/prod/tests/release-drill.sh
bash scripts/prod/tests/prune-drill.sh
```

覆盖场景包括：完整备份与临时恢复、数据库与文件卷回滚、失败现场备份、正常发布与最终确认、Prisma 迁移失败自动回滚、磁盘不足阻断、损坏备份阻断，以及只保留最近两个成功恢复点。
