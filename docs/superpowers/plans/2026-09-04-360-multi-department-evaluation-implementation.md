# 360 多部门互评实施计划

**日期**：2026-09-04
**需求基线**：`docs/superpowers/specs/2026-09-03-360-multi-department-evaluation-design.md`
**实施范围**：仅本地环境；不推送远程 Git；不改写历史批次、历史关系、答卷和结果。

## 1. 当前基线与实施约束

- 通讯录已经存在 `OrgDepartment` 与 `ContactDepartmentMembership`，并支持一个主部门、多个兼任部门以及 `defaultEvalEnabled`。
- V2 环评目前仍只把 `Contact.department` 写入 `EvalCycleParticipant.groupKey/groupName`，关系生成只读取一个小组。
- `EvalPages.tsx`、`schema.prisma`、组织服务等文件已有本地未提交改动；实施时只做增量补丁，不能覆盖或清理现有工作区。
- `EvalCycleParticipant.departmentSnapshot/groupKey/groupName` 继续作为主部门兼容字段，旧批次没有多小组快照时仍按原逻辑读取。
- 所有写操作同时校验：V2 批次、草稿状态、没有已提交答卷。不能只依赖前端禁用。
- 数据库只新增表和索引，不修改或回填历史数据。

## 2. 实施顺序总览

1. 先为多小组关系计算补纯函数测试，锁定去重、自评和特殊人员规则。
2. 新增批次小组快照表和 Prisma 关系。
3. 扩展候选、预览、确认人员与复制上期范围的后端流程。
4. 增加当期小组调整接口和重新生成状态判断。
5. 将 V2 自动关系生成器切换到多小组快照，并补充关系来源。
6. 用 Ant Design 改造参评人员、生成报告和关系复核页面。
7. 完成构建、单测、迁移和本地场景验收。

## 3. 任务一：多小组领域计算与单元测试

涉及文件：

- 新增 `backend/src/eval-participant-groups.ts`
- 新增 `backend/src/eval-participant-groups.spec.ts`

实施内容：

1. 定义最小输入类型：参评人 ID、联系人 ID、模式、开启的小组快照。
2. 实现纯函数 `buildMultiGroupAutoRelations`：
   - 只处理 `mode=normal` 的人员。
   - 每个普通人员只产生一条自评。
   - 每个开启小组内生成双向他评候选。
   - 使用 `raterContactId + rateeContactId` 对有向关系去重。
   - 返回去重后的关系、每组人数、每组候选数、单人组警告和覆盖小组数。
3. 实现纯函数 `findSharedEnabledGroups`，根据两人的快照求稳定共同小组；自评不使用该函数解释来源。
4. 先写失败测试，再完成实现，覆盖：
   - 两人同组生成双方自评与双向他评。
   - 一人通过兼任部门进入另一人的主部门组。
   - 两人共享多个小组仍只有一组双向关系。
   - 关闭的兼任部门不参与生成。
   - 特殊人员不进入自动关系。
   - 单人组仅产生自评且给出警告。
   - 丁史远与查曌通过“查曌激活组”形成双向互评。

验证命令：

```powershell
cd backend
npm test -- --runInBand eval-participant-groups.spec.ts
```

## 4. 任务二：批次小组快照数据模型

涉及文件：

- `backend/prisma/schema.prisma`
- 新增 `backend/prisma/migrations/20260904000000_add_eval_participant_group_snapshots/migration.sql`

实施内容：

1. 新增 `EvalParticipantGroupSnapshot`：
   - `participantId`
   - `departmentId`
   - `departmentCodeSnapshot`
   - `departmentNameSnapshot`
   - `departmentPathSnapshot`
   - `isPrimarySnapshot`
   - `evalEnabled`
   - `roleNameSnapshot`
   - 创建与更新时间
2. 建立 `participantId + departmentId` 唯一约束，以及分组生成所需索引。
3. `participantId` 外键使用级联删除；`departmentId` 外键使用限制删除。
4. 在 `EvalCycleParticipant` 和 `OrgDepartment` 增加反向关系。
5. 不为历史参评人回填记录；兼容逻辑由服务层处理。

验证命令：

```powershell
cd backend
npx prisma format
npm run prisma:generate
npm run build
```

## 5. 任务三：候选人员、预览与确认快照

涉及文件：

- `backend/src/eval-participant-groups.ts`
- `backend/src/eval.service.ts`
- `backend/src/eval.controller.ts`
- 新增 `backend/src/eval-multi-group.spec.ts`

### 5.1 共用快照规划器

新增服务层共用方法，供预览与最终保存共同调用，避免两套规则产生差异：

1. 一次读取所选启用联系人、全部部门归属和组织部门。
2. 构建稳定部门完整路径映射。
3. 对每名联系人验证：
   - 联系人启用。
   - 恰好一个主部门。
   - 主部门存在、启用且为末级部门。
   - 不存在重复部门归属。
4. 主部门快照强制 `evalEnabled=true`。
5. 兼任部门继承 `defaultEvalEnabled`；停用兼任部门保留快照但默认关闭并给出警告。
6. 返回参评人记录、小组快照记录与摘要，不直接写数据库。

### 5.2 候选人员接口

扩展 `GET /api/admin/eval/participant-candidates`：

- 只返回启用联系人。
- 每个联系人返回全部归属、完整路径、主/兼任类型、职责与默认互评开关。
- 部门筛选项按稳定部门 ID 和完整路径返回，并统计去重后的联系人数量。

### 5.3 预览接口

新增 `POST /api/admin/eval/cycles/:id/participants/preview`，请求体仍为 `contactIds`，返回：

- 参评人员数。
- 开启的小组数。
- 多小组人员数。
- 单人小组和人员名单。
- 停用兼任部门等警告。
- 阻断错误直接返回具体员工和原因。

### 5.4 确认人员范围

改造 `PUT /api/admin/eval/cycles/:id/participants`：

1. 使用与预览相同的快照规划器。
2. 在单个事务中删除旧自动关系。
3. 人工关系仅当评价人与被评价人都仍在新参评范围时保留；涉及移除人员的人工关系删除。
4. 替换参评人及其小组快照。
5. 旧兼容字段写入主部门路径。
6. 审计日志记录人员数、小组数、多小组人员数、保留及删除的人工关系数。
7. 返回预览摘要和 `relationsNeedRegeneration=true`。

### 5.5 复制上一批次

“复制上一批次”只复制联系人范围；新批次仍从当前通讯录重新生成主/兼任部门快照，不复制来源批次的旧组织状态。

测试覆盖：

- 主部门强制开启，兼任部门继承默认开关。
- 主部门缺失、重复、停用或非末级时阻断。
- 预览与保存摘要一致。
- 替换人员时自动关系删除，仍在范围内的人工关系保留，悬空人工关系删除。
- 历史无小组快照的参评人查询仍返回兼容数据。

## 6. 任务四：当期小组调整

涉及文件：

- `backend/src/eval.service.ts`
- `backend/src/eval.controller.ts`
- `backend/src/eval-multi-group.spec.ts`

实施内容：

1. `GET /api/admin/eval/cycles/:id/participants` 同时返回 `groups`：主部门、兼任部门、快照路径、角色和当期开关。
2. 新增 `PUT /api/admin/eval/cycles/:id/participants/:participantId/groups`：
   - 只接受已存在快照的兼任部门开关。
   - 拒绝关闭主部门或添加通讯录中不存在的归属。
   - 不回写通讯录。
   - 记录调整前后审计日志。
3. 小组调整后不在后台静默修改关系。
4. 通过“小组快照最后更新时间晚于最新自动关系创建时间”判断 `relationsNeedRegeneration`；没有自动关系时也返回需要生成。
5. 已有答卷时拒绝调整。

## 7. 任务五：V2 多小组关系生成与来源解释

涉及文件：

- `backend/src/eval-participant-groups.ts`
- `backend/src/eval.service.ts`
- `backend/src/eval-multi-group.spec.ts`

实施内容：

1. `generateV2Relations` 读取参评人及其 `evalEnabled=true` 的小组快照。
2. 新批次有小组快照时调用 `buildMultiGroupAutoRelations`；历史草稿没有快照时继续使用原单一 `groupKey` 逻辑。
3. 生成前拒绝已有答卷的批次。
4. 事务中只删除并重建 `source=auto` 的关系，人工关系不覆盖；同方向已有人工关系时跳过自动候选。
5. 生成报告按去重后的真实数据返回：参评人数、普通/特殊人数、自评数、他评数、覆盖小组数、各组人数和单人组警告。
6. `listRelations` 对自动他评关系返回 `sharedGroups`；人工关系返回空数组；自动自评由前端显示“自动·自评”。
7. `getV2ReviewList` 返回参评人的开启小组快照，并继续按唯一关系统计，不因多个共同小组重复计数。

测试覆盖：

- 多组生成后的唯一键集合正确。
- 人工关系优先于同方向自动关系。
- 重新生成只替换自动关系。
- 关系来源使用批次快照，通讯录后来改名不改变来源。
- 旧批次无小组快照时行为不变。

## 8. 任务六：Ant Design 管理端改造

涉及文件：

- `frontend/src/EvalPages.tsx`
- `frontend/src/index.css`（仅在 Ant Design 组件无法覆盖的局部布局需要时修改）

### 8.1 参评人员

1. 扩展候选与参评人 TypeScript 类型，避免继续在新增逻辑中使用无约束对象。
2. 部门筛选使用部门 ID，匹配员工任一归属，同一员工只勾选一次。
3. 候选表格“部门/组”展示主部门及兼任部门标签。
4. 点击“确认人员范围”时先调用预览接口，再用 Ant Design Modal 展示人员、小组、多小组人员和单人组摘要；管理员确认后才保存。
5. 参评人员的“当期互评小组”最多显示三个标签：绿色主部门、蓝色开启兼任部门，其余使用 `+N` Tooltip。
6. 每个已加入人员增加“调整小组”操作，打开 Ant Design Drawer：
   - 主部门 Switch 锁定开启。
   - 兼任部门可切换。
   - Alert 明确“仅影响当前批次，不修改通讯录”。
   - 保存成功后刷新参评人并提示需要重新生成关系。

### 8.2 生成与复核

1. 删除现有基于单一人数计算 `N²` 的前端提示，完全展示后端生成报告。
2. 报告新增覆盖小组数与各组警告。
3. 当 `relationsNeedRegeneration=true` 时在人员与关系页显示警告。
4. 关系明细“来源”列：
   - 自评显示“自动·自评”。
   - 自动他评显示一个或多个共同小组标签。
   - 人工关系显示紫色“人工”。
5. 特殊人员列表的评价小组列同步展示当期开启小组，不改变现有特殊人员操作。

前端验证：

```powershell
cd frontend
npm run build
```

## 9. 任务七：迁移、构建与本地验收

### 9.1 自动验证

```powershell
cd backend
npm test -- --runInBand eval-participant-groups.spec.ts eval-multi-group.spec.ts
npx prisma validate
npm run build

cd ..\frontend
npm run build
```

### 9.2 本地迁移

1. 确认操作目标是本地 MySQL 容器，不连接正式数据库。
2. 应用新增迁移并重新生成 Prisma Client。
3. 重启本地后端与前端服务。
4. 检查迁移表和新增快照表存在，历史表行数未改变。

### 9.3 场景验收

在“测试全公司环评”草稿批次执行：

1. 重新选择并预览人员范围。
2. 核对查曌显示主部门“查曌组”和开启的兼任部门“查曌激活组”。
3. 核对丁史远显示主部门“查曌激活组”。
4. 确认人员并一键重新生成关系。
5. 验证且仅验证到以下唯一关系：
   - 丁史远自评一条。
   - 查曌自评一条。
   - 丁史远评价查曌一条，来源“查曌激活组”。
   - 查曌评价丁史远一条，来源“查曌激活组”。
6. 临时关闭查曌的该兼任组，确认页面提示需重新生成；重新生成后双向互评消失，自评保留。
7. 再次开启并重新生成，确认双向互评恢复。
8. 回归特殊人员、人工关系、发布前复核、填写端任务、历史批次查看和普通问卷页面。

## 10. 完成标准

- 设计文档中的八条验收标准全部通过。
- 新增测试通过，前后端构建通过。
- 本地迁移成功，历史数据未改写。
- 丁史远与查曌场景验证通过。
- 没有提交临时文件或覆盖工作区既有改动。
- 不推送任何远程 Git 分支或提交。

## 11. 建议的本地提交拆分

1. `feat: add evaluation participant group snapshots`
2. `feat: generate evaluation relations from multiple groups`
3. `feat: manage participant groups in evaluation UI`
4. `test: verify multi-department evaluation flow`

每次提交前只暂存本任务明确修改的文件，并检查暂存区，避免带入现有未提交内容。
