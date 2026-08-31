# 生产备份脚本

这组脚本实现“发布前完整恢复点”的备份阶段。正式规则以
[`docs/superpowers/specs/2026-08-28-production-backup-rollback-design.md`](../../docs/superpowers/specs/2026-08-28-production-backup-rollback-design.md)
为准。

## 当前提供

- `preflight.sh`：检查 Git、Compose 服务、MySQL/Prisma、InnoDB、三个命名卷、权限、磁盘空间和历史备份哈希。
- `backup.sh`：停止后端和 MinIO 写入，备份数据库、uploads、MinIO、`.env`、Compose 配置和版本清单。
- `verify-backup.sh`：校验压缩包与 SHA-256，将 SQL 恢复到随机临时库，逐表核对精确行数与 Prisma 迁移。
- `list-backups.sh`：安全列出恢复点及校验状态，不输出环境密钥。
- `prune-backups.sh`：仅清理多于最近 2 个的 `RELEASE_SUCCEEDED` 恢复点。

`release.sh` 和 `rollback.sh` 尚未实现。在发布、回滚脚本和恢复演练完成前，不能把这组脚本视为已经完成整套生产发布/回滚能力。

## 前置条件

- Linux、Bash、Docker Compose v2、Git、Python 3、GNU `realpath`、`gzip`、`tar`、`sha256sum`、`flock`。Python 默认命令为 `python3`，可通过 `PYTHON_BIN` 覆盖。
- 当前 Compose 服务名为 `mysql`、`app-backend`、`minio`；可通过同名环境变量覆盖。
- MySQL 容器内存在 `MYSQL_ROOT_PASSWORD` 或 `MYSQL_ROOT_PASSWORD_FILE`。
- 辅助镜像 `node:20-alpine` 已存在；可用 `HELPER_IMAGE` 覆盖。
- 正式项目目录和备份根目录默认分别为 `/www/wwwroot/survey-app`、`/www/backup/survey-app`。

脚本不会把 MySQL 密码写入命令行或日志；`.env` 备份和整个恢复点目录权限均限制为仅所有者访问。

## 建议操作顺序

先执行只读检查：

```bash
sudo bash scripts/prod/preflight.sh --target-ref <目标-git-ref> --dry-run
sudo bash scripts/prod/backup.sh --target-ref <目标-git-ref> --dry-run
```

单独创建并验证恢复点（验证结束会恢复旧后端和 MinIO）：

```bash
sudo bash scripts/prod/backup.sh --target-ref <目标-git-ref>
```

未来由统一发布脚本串联时，必须保持维护状态：

```bash
sudo bash scripts/prod/backup.sh --target-ref <目标-git-ref> --hold-maintenance
```

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
