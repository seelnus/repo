import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import dayjs from "dayjs";
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  DownOutlined,
  FileDoneOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  App as AntApp,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  QRCode,
  Radio,
  Rate,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { http, fillHttp, downloadFile } from "./App";
import {
  buildEvalFillTaskView,
  getEvalDeadlineState,
  getEvalFillDisplayName,
} from "./eval-fill-view-model";
import type {
  EvalFillTaskGroup,
  EvalFillTaskItem,
} from "./eval-fill-view-model";

// ── 类型（宽松定义，够用即可）──
interface Cycle {
  id: number;
  name: string;
  scopeDepartment: string | null;
  selfSurveyId: number | null;
  peerSurveyId: number | null;
  leaderSurveyId: number | null;
  templateSurveyId?: number | null;
  templateSnapshotJson?: EvalTemplate | null;
  version?: number;
  startAt?: string | null;
  endAt?: string | null;
  lockedAt?: string | null;
  participantCount?: number;
  status: string;
  relationCount?: number;
  createdAt?: string;
}
interface SurveyLite {
  id: number;
  title: string;
}
interface ContactLite {
  id: number;
  name: string;
  department?: string | null;
  position?: string | null;
  tags?: string | null;
  memberships?: ContactMembershipLite[];
}
interface ContactMembershipLite {
  departmentId: number;
  departmentName: string;
  departmentPath: string;
  isPrimary: boolean;
  defaultEvalEnabled: boolean;
  roleName?: string | null;
  isActive: boolean;
}
interface ParticipantGroupSnapshotLite {
  id: number;
  departmentId: number;
  departmentNameSnapshot: string;
  departmentPathSnapshot: string;
  isPrimarySnapshot: boolean;
  evalEnabled: boolean;
  roleNameSnapshot?: string | null;
}
interface EvalParticipantLite {
  id: number;
  contactId: number;
  nameSnapshot: string;
  departmentSnapshot?: string | null;
  positionSnapshot?: string | null;
  groupName: string;
  mode: string;
  peerExempt: boolean;
  groups: ParticipantGroupSnapshotLite[];
  relationsNeedRegeneration?: boolean;
}

interface EvalProgressPerson {
  relationId: number;
  contactId: number;
  name: string;
  source: string;
  sharedGroups: Array<{
    departmentId: number | null;
    name: string;
    path: string;
  }>;
}

interface EvalProgressGroup {
  type: "self" | "peer" | "leader";
  label: string;
  total: number;
  completedCount: number;
  pendingCount: number;
  completionRate: number | null;
  completed: EvalProgressPerson[];
  pending: EvalProgressPerson[];
}

interface EvalRaterProgress {
  participant: { contactId: number; name: string };
  summary: {
    total: number;
    completed: number;
    pending: number;
    completionRate: number | null;
  };
  groups: EvalProgressGroup[];
}
interface ParticipantPreview {
  participantCount: number;
  enabledGroupCount: number;
  multiGroupParticipantCount: number;
  singlePersonGroupCount: number;
  singlePersonGroups: Array<{
    departmentId: number;
    name: string;
    path: string;
    contactId: number;
  }>;
  warnings: string[];
}
interface EvalQuestionBase {
  id: string;
  label: string;
  description?: string;
  dimensionId: string;
  required: boolean;
}
interface EvalScoreQuestion extends EvalQuestionBase {
  type: "evaluation_score";
  countInScore: boolean;
  options: Array<{ score: number; label: string }>;
  casePrompt?: string;
  caseRequiredScores: number[];
}
interface EvalTextQuestion extends EvalQuestionBase {
  type: "evaluation_text";
  maxLength: 2000;
}
type EvalQuestion = EvalScoreQuestion | EvalTextQuestion;
interface EvalTemplate {
  version: 2;
  kind: "evaluation";
  instructions?: string;
  dimensions: Array<{ id: string; name: string; order: number }>;
  questions: EvalQuestion[];
}
interface EvalTemplateRow {
  id: number;
  title: string;
  schemaJson: EvalTemplate;
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  draft: { text: "草稿", color: "default" },
  published: { text: "已发布", color: "green" },
  closed: { text: "已截止", color: "red" },
  locked: { text: "已锁定", color: "purple" },
  archived: { text: "已归档", color: "default" },
};
const TYPE_LABEL: Record<string, string> = {
  self: "自评",
  peer: "他评",
  leader: "领导评价",
};

function useSurveys() {
  const [surveys, setSurveys] = useState<SurveyLite[]>([]);
  useEffect(() => {
    http
      .get("/admin/surveys")
      .then((r) => setSurveys(r.data || []))
      .catch(() => {});
  }, []);
  return surveys;
}

function useEvalTemplates() {
  const [templates, setTemplates] = useState<EvalTemplateRow[]>([]);
  const load = () =>
    http
      .get("/admin/eval/templates")
      .then((response) => setTemplates(response.data || []))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return { templates, reload: load };
}

// ============ 批次列表 ============
export function EvalCycleList() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await http.get("/admin/eval/cycles");
      setCycles(data || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const { data } = await http.post("/admin/eval/cycles", values);
      message.success("批次已创建");
      setModalOpen(false);
      form.resetFields();
      navigate(`/eval/${data.id}`);
    } catch (e: any) {
      message.error(e.response?.data?.message || "创建失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await http.delete(`/admin/eval/cycles/${id}`);
      message.success("已删除");
      load();
    } catch (e: any) {
      message.error(e.response?.data?.message || "删除失败");
    }
  }

  return (
    <Card
      title="360 环评批次"
      extra={
        <Button type="primary" onClick={() => setModalOpen(true)}>
          新建批次
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={cycles}
        pagination={false}
        columns={[
          { title: "批次名称", dataIndex: "name" },
          {
            title: "参评人数",
            dataIndex: "participantCount",
            width: 110,
            render: (v) => v || 0,
          },
          { title: "关系数", dataIndex: "relationCount", width: 100 },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (s: string) => (
              <Tag color={STATUS_LABEL[s]?.color}>
                {STATUS_LABEL[s]?.text || s}
              </Tag>
            ),
          },
          {
            title: "操作",
            width: 180,
            render: (_: any, r: Cycle) => (
              <Space>
                <Button type="link" onClick={() => navigate(`/eval/${r.id}`)}>
                  进入批次
                </Button>
                <Popconfirm
                  title="删除该批次？关系一并删除"
                  onConfirm={() => handleDelete(r.id)}
                >
                  <Button type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="新建评价批次"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="批次名称"
            rules={[{ required: true, message: "请输入批次名称" }]}
          >
            <Input placeholder="如：2026 Q2 技术部 360 环评" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="创建后进入批次，依次配置统一题目模板、参评人员、评价关系和时间。"
          />
        </Form>
      </Modal>
    </Card>
  );
}

// ============ 新版批次详情（方案 B）============
export function EvalCycleDetail() {
  const { id } = useParams();
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    http
      .get(`/admin/eval/cycles/${id}`)
      .then((response) => setCycle(response.data))
      .finally(() => setLoading(false));
  }, [id]);
  if (loading)
    return (
      <div style={{ textAlign: "center", padding: 60 }}>
        <Spin />
      </div>
    );
  if (!cycle) return <Empty description="批次不存在" />;
  if ((cycle.version || 1) < 2) return <LegacyEvalCycleDetail />;
  return <EvalCycleV2Detail initialCycle={cycle} />;
}

function EvalCycleV2Detail({ initialCycle }: { initialCycle: Cycle }) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [cycle, setCycle] = useState(initialCycle);
  const [activeTab, setActiveTab] = useState("overview");
  const [shareOpen, setShareOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenEndAt, setReopenEndAt] = useState<any>(null);
  const fillUrl = `${location.origin}/eval-fill`;

  async function reload() {
    const { data } = await http.get(`/admin/eval/cycles/${cycle.id}`);
    setCycle(data);
  }

  async function lifecycle(action: "publish" | "close" | "lock" | "archive") {
    try {
      await http.post(`/admin/eval/cycles/${cycle.id}/${action}`);
      message.success(
        {
          publish: "批次已发布",
          close: "批次已截止",
          lock: "结果已锁定",
          archive: "批次已归档",
        }[action],
      );
      reload();
    } catch (error: any) {
      message.error(error.response?.data?.message || "操作失败");
    }
  }

  async function reopen() {
    if (!reopenEndAt) return message.warning("请选择新的截止时间");
    try {
      await http.post(`/admin/eval/cycles/${cycle.id}/reopen`, {
        endAt: reopenEndAt.toISOString(),
      });
      message.success("批次已重新开放");
      setReopenOpen(false);
      setReopenEndAt(null);
      reload();
    } catch (error: any) {
      message.error(error.response?.data?.message || "重新开放失败");
    }
  }

  const actions = (
    <Space wrap>
      {cycle.status === "draft" && (
        <Button type="primary" onClick={() => lifecycle("publish")}>
          发布批次
        </Button>
      )}
      {cycle.status === "published" && (
        <Button danger onClick={() => lifecycle("close")}>
          立即截止
        </Button>
      )}
      {cycle.status === "closed" && (
        <>
          <Button onClick={() => setReopenOpen(true)}>重新开放</Button>
          <Button type="primary" onClick={() => lifecycle("lock")}>
            锁定结果
          </Button>
        </>
      )}
      {cycle.status === "locked" && (
        <Button onClick={() => lifecycle("archive")}>归档</Button>
      )}
      <Button onClick={() => setShareOpen(true)}>填写入口</Button>
    </Space>
  );

  return (
    <div className="eval-v2-shell">
      <div className="eval-v2-heading">
        <Space wrap>
          <Button type="link" onClick={() => navigate("/eval")}>
            ← 返回批次
          </Button>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {cycle.name}
          </Typography.Title>
          <Tag color={STATUS_LABEL[cycle.status]?.color}>
            {STATUS_LABEL[cycle.status]?.text || cycle.status}
          </Tag>
        </Space>
        {actions}
      </div>
      <Tabs
        className="eval-module-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "overview",
            label: "环评概览",
            children: (
              <EvalOverviewTab
                cycle={cycle}
                onCycleSaved={reload}
                onNavigate={setActiveTab}
              />
            ),
          },
          {
            key: "template",
            label: "题目模板",
            children: <EvalTemplateTab cycle={cycle} onSaved={reload} />,
          },
          {
            key: "people",
            label: "人员与关系",
            children: <EvalPeopleTab cycle={cycle} />,
          },
          {
            key: "execution",
            label: "评估执行",
            children: <EvalExecutionTab cycle={cycle} fillUrl={fillUrl} />,
          },
          {
            key: "reports",
            label: "统计报告",
            children: <EvalReportsTab cycle={cycle} />,
          },
        ]}
      />
      <Modal
        title="员工填写入口"
        open={shareOpen}
        onCancel={() => setShareOpen(false)}
        footer={null}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="整个批次共用一个入口。员工登录后只会看到分配给自己的评价任务。"
        />
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <QRCode value={fillUrl} size={180} />
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input readOnly value={fillUrl} />
          <Button
            onClick={() =>
              navigator.clipboard
                ?.writeText(fillUrl)
                .then(() => message.success("链接已复制"))
            }
          >
            复制
          </Button>
        </Space.Compact>
      </Modal>
      <Modal
        title="重新开放批次"
        open={reopenOpen}
        onCancel={() => setReopenOpen(false)}
        onOk={reopen}
      >
        <Typography.Paragraph type="secondary">
          请选择新的截止时间，重新开放后员工可继续完成未提交任务。
        </Typography.Paragraph>
        <DatePicker
          showTime
          style={{ width: "100%" }}
          value={reopenEndAt}
          onChange={setReopenEndAt}
        />
      </Modal>
    </div>
  );
}

function EvalOverviewTab({
  cycle,
  onCycleSaved,
  onNavigate,
}: {
  cycle: Cycle;
  onCycleSaved: () => void;
  onNavigate: (key: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [overview, setOverview] = useState<any>(null);
  const [form] = Form.useForm();
  const readonly = cycle.status !== "draft";
  useEffect(() => {
    http
      .get(`/admin/eval/cycles/${cycle.id}/overview`)
      .then((response) => setOverview(response.data));
    form.setFieldsValue({
      name: cycle.name,
      startAt: cycle.startAt ? dayjs(cycle.startAt) : null,
      endAt: cycle.endAt ? dayjs(cycle.endAt) : null,
    });
  }, [cycle.id, cycle.name, cycle.startAt, cycle.endAt]);

  async function save() {
    const values = await form.validateFields();
    try {
      const payload =
        cycle.status === "draft"
          ? {
              name: values.name,
              startAt: values.startAt?.toISOString(),
              endAt: values.endAt?.toISOString(),
            }
          : { endAt: values.endAt?.toISOString() };
      await http.put(`/admin/eval/cycles/${cycle.id}`, payload);
      message.success("批次基础信息已保存");
      onCycleSaved();
    } catch (error: any) {
      message.error(error.response?.data?.message || "保存失败");
    }
  }

  return (
    <div>
      <Row gutter={[16, 16]} className="eval-stat-grid">
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="参评人数"
              value={overview?.participantCount || 0}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="评价任务" value={overview?.totalTasks || 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="已提交" value={overview?.submittedTasks || 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="任务完成率"
              value={(overview?.completionRate || 0) * 100}
              precision={1}
              suffix="%"
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={20} style={{ marginTop: 20 }}>
        <Col xs={24} lg={14}>
          <Card title="批次基础信息">
            <Form form={form} layout="vertical">
              <Form.Item
                name="name"
                label="批次名称"
                rules={[{ required: true, message: "请输入批次名称" }]}
              >
                <Input disabled={readonly} />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    name="startAt"
                    label="开始时间"
                    rules={[{ required: true, message: "请选择开始时间" }]}
                  >
                    <DatePicker
                      showTime
                      style={{ width: "100%" }}
                      disabled={readonly}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="endAt"
                    label="截止时间"
                    rules={[{ required: true, message: "请选择截止时间" }]}
                  >
                    <DatePicker
                      showTime
                      style={{ width: "100%" }}
                      disabled={["locked", "archived"].includes(cycle.status)}
                    />
                  </Form.Item>
                </Col>
              </Row>
              {!["locked", "archived", "closed"].includes(cycle.status) && (
                <Button type="primary" onClick={save}>
                  {cycle.status === "draft" ? "保存基础信息" : "更新截止时间"}
                </Button>
              )}
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="配置进度">
            <div className="eval-check-row">
              <span>统一题目模板</span>
              {cycle.templateSurveyId ? (
                <Tag color="green">已配置</Tag>
              ) : (
                <Button type="link" onClick={() => onNavigate("template")}>
                  去配置
                </Button>
              )}
            </div>
            <div className="eval-check-row">
              <span>参评人员快照</span>
              {(overview?.participantCount || 0) > 0 ? (
                <Tag color="green">{overview.participantCount} 人</Tag>
              ) : (
                <Button type="link" onClick={() => onNavigate("people")}>
                  去选择
                </Button>
              )}
            </div>
            <div className="eval-check-row">
              <span>评价关系</span>
              {(overview?.totalTasks || 0) > 0 ? (
                <Tag color="green">{overview.totalTasks} 条</Tag>
              ) : (
                <Button type="link" onClick={() => onNavigate("people")}>
                  去生成
                </Button>
              )}
            </div>
            <Alert
              style={{ marginTop: 16 }}
              type="info"
              showIcon
              message="评分规则：所有有效答卷等权；每题先平均，员工总分再按全部计分题平均。"
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

const DEFAULT_SCORE_LABELS = [
  "未体现或产生明显负面影响",
  "偶尔体现，仍需重点改进",
  "基本体现，但稳定性不足",
  "符合岗位与团队要求",
  "表现优秀，并能积极影响他人",
  "树立标杆，并推动形成机制",
];

function createDefaultTemplate(): EvalTemplate {
  const suffix = Date.now().toString(36);
  const dimensionId = `dimension-${suffix}`;
  return {
    version: 2,
    kind: "evaluation",
    instructions: "",
    dimensions: [{ id: dimensionId, name: "价值观", order: 1 }],
    questions: [
      {
        id: `question-${suffix}`,
        type: "evaluation_score",
        label: "请填写题目标题",
        description: "",
        dimensionId,
        required: true,
        countInScore: true,
        options: DEFAULT_SCORE_LABELS.map((label, score) => ({ score, label })),
        casePrompt: "请填写具体案例，做到有理有据",
        caseRequiredScores: [0, 4, 5],
      },
    ],
  };
}

function EvalTemplateTab({
  cycle,
  onSaved,
}: {
  cycle: Cycle;
  onSaved: () => void;
}) {
  const { message } = AntApp.useApp();
  const { templates, reload } = useEvalTemplates();
  const [selectedId, setSelectedId] = useState<number | undefined>(
    cycle.templateSurveyId || undefined,
  );
  const [schema, setSchema] = useState<EvalTemplate>(createDefaultTemplate());
  const [title, setTitle] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const readonly = cycle.status !== "draft";

  useEffect(() => {
    const row = templates.find((template) => template.id === selectedId);
    if (row) {
      setTitle(row.title);
      setSchema(row.schemaJson);
    }
  }, [selectedId, templates]);

  async function bindTemplate(id: number) {
    setSelectedId(id);
    try {
      await http.put(`/admin/eval/cycles/${cycle.id}`, {
        templateSurveyId: id,
      });
      message.success("统一模板已绑定");
      onSaved();
    } catch (error: any) {
      message.error(error.response?.data?.message || "绑定失败");
    }
  }

  async function createTemplate() {
    if (!newTitle.trim()) return message.warning("请输入模板名称");
    try {
      const { data } = await http.post("/admin/eval/templates", {
        title: newTitle.trim(),
        schemaJson: createDefaultTemplate(),
      });
      setCreateOpen(false);
      setNewTitle("");
      await reload();
      await bindTemplate(data.id);
    } catch (error: any) {
      message.error(error.response?.data?.message || "创建失败");
    }
  }

  async function saveTemplate() {
    if (!selectedId) return;
    try {
      await http.put(`/admin/eval/templates/${selectedId}`, {
        title,
        schemaJson: schema,
      });
      message.success("模板已保存");
      reload();
    } catch (error: any) {
      message.error(error.response?.data?.message || "保存失败");
    }
  }

  function updateDimension(index: number, name: string) {
    setSchema((current) => ({
      ...current,
      dimensions: current.dimensions.map((dimension, i) =>
        i === index ? { ...dimension, name } : dimension,
      ),
    }));
  }

  function updateQuestion(
    index: number,
    patch: Partial<EvalScoreQuestion> | Partial<EvalTextQuestion>,
  ) {
    setSchema((current) => ({
      ...current,
      questions: current.questions.map((question, i) =>
        i === index ? ({ ...question, ...patch } as EvalQuestion) : question,
      ),
    }));
  }

  function addDimension() {
    const id = `dimension-${Date.now().toString(36)}`;
    setSchema((current) => ({
      ...current,
      dimensions: [
        ...current.dimensions,
        {
          id,
          name: `新维度${current.dimensions.length + 1}`,
          order: current.dimensions.length + 1,
        },
      ],
    }));
  }

  function addScoreQuestion() {
    const dimensionId = schema.dimensions[0]?.id;
    if (!dimensionId) return message.warning("请先添加维度");
    const id = `question-${Date.now().toString(36)}`;
    setSchema((current) => ({
      ...current,
      questions: [
        ...current.questions,
        {
          id,
          type: "evaluation_score",
          label: "新题目",
          description: "",
          dimensionId,
          required: true,
          countInScore: true,
          options: DEFAULT_SCORE_LABELS.map((label, score) => ({
            score,
            label,
          })),
          casePrompt: "请填写具体案例",
          caseRequiredScores: [0, 4, 5],
        },
      ],
    }));
  }

  function addTextQuestion() {
    const dimensionId = schema.dimensions[0]?.id;
    if (!dimensionId) return message.warning("请先添加维度");
    const id = `text-question-${Date.now().toString(36)}`;
    setSchema((current) => ({
      ...current,
      questions: [
        ...current.questions,
        {
          id,
          type: "evaluation_text",
          label: "新填空题",
          description: "",
          dimensionId,
          required: false,
          maxLength: 2000,
        },
      ],
    }));
  }

  return (
    <div>
      <Card className="eval-toolbar-card">
        <Space wrap>
          <Select
            style={{ width: 360 }}
            placeholder="选择统一环评模板"
            value={selectedId}
            disabled={readonly}
            options={templates.map((template) => ({
              label: template.title,
              value: template.id,
            }))}
            onChange={bindTemplate}
          />
          {!readonly && (
            <Button onClick={() => setCreateOpen(true)}>新建模板</Button>
          )}
          {selectedId && !readonly && (
            <Button type="primary" onClick={saveTemplate}>
              保存模板
            </Button>
          )}
        </Space>
      </Card>
      {!selectedId ? (
        <Empty
          style={{ marginTop: 48 }}
          description="请选择或新建一份统一环评模板"
        />
      ) : (
        <div className="eval-template-layout">
          <Card title="维度" className="eval-dimension-card">
            {schema.dimensions.map((dimension, index) => (
              <Input
                key={dimension.id}
                value={dimension.name}
                disabled={readonly}
                style={{ marginBottom: 10 }}
                onChange={(event) => updateDimension(index, event.target.value)}
              />
            ))}
            {!readonly && (
              <Button block onClick={addDimension}>
                添加维度
              </Button>
            )}
          </Card>
          <div>
            <Input
              value={title}
              disabled={readonly}
              className="eval-template-title"
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="eval-template-instructions-editor">
              <Typography.Text strong>填写说明（选填）</Typography.Text>
              <Input.TextArea
                rows={4}
                showCount
                maxLength={2000}
                value={schema.instructions || ""}
                disabled={readonly}
                placeholder="请输入本次环评的填写规范、评价口径或注意事项"
                onChange={(event) =>
                  setSchema((current) => ({
                    ...current,
                    instructions: event.target.value,
                  }))
                }
              />
            </div>
            {schema.questions.map((question, index) => (
              <Card
                key={question.id}
                className={`eval-question-editor ${question.type === "evaluation_score" ? "eval-score-question-editor" : ""}`}
                title={
                  <Space className="eval-question-editor-title">
                    <span className="eval-question-number">
                      题目 {String(index + 1).padStart(2, "0")}
                    </span>
                    <Tag
                      color={
                        question.type === "evaluation_text" ? "cyan" : "blue"
                      }
                    >
                      {question.type === "evaluation_text"
                        ? "填空题"
                        : "评分题"}
                    </Tag>
                  </Space>
                }
                extra={
                  <Space wrap className="eval-question-editor-actions">
                    {question.type === "evaluation_score" && (
                      <>
                        <Checkbox
                          checked={question.required}
                          disabled={readonly}
                          onChange={(event) =>
                            updateQuestion(index, {
                              required: event.target.checked,
                            })
                          }
                        >
                          必答
                        </Checkbox>
                        <Checkbox
                          checked={question.countInScore}
                          disabled={readonly}
                          onChange={(event) =>
                            updateQuestion(index, {
                              countInScore: event.target.checked,
                            })
                          }
                        >
                          计入总分
                        </Checkbox>
                      </>
                    )}
                    {!readonly && (
                      <Button
                        type="link"
                        danger
                        onClick={() =>
                          setSchema((current) => ({
                            ...current,
                            questions: current.questions.filter(
                              (_, i) => i !== index,
                            ),
                          }))
                        }
                      >
                        删除
                      </Button>
                    )}
                  </Space>
                }
              >
                {question.type === "evaluation_score" ? (
                  <EvalScoreQuestionEditor
                    question={question}
                    dimensions={schema.dimensions}
                    readonly={readonly}
                    onChange={(patch) => updateQuestion(index, patch)}
                  />
                ) : (
                  <>
                    <Input
                      value={question.label}
                      disabled={readonly}
                      placeholder="题目标题"
                      onChange={(event) =>
                        updateQuestion(index, { label: event.target.value })
                      }
                    />
                    <Input.TextArea
                      style={{ marginTop: 10 }}
                      value={question.description}
                      disabled={readonly}
                      placeholder="补充说明（可选）"
                      onChange={(event) =>
                        updateQuestion(index, {
                          description: event.target.value,
                        })
                      }
                    />
                    <Select
                      style={{ width: "100%", marginTop: 10 }}
                      value={question.dimensionId}
                      disabled={readonly}
                      options={schema.dimensions.map((dimension) => ({
                        label: dimension.name,
                        value: dimension.id,
                      }))}
                      onChange={(dimensionId) =>
                        updateQuestion(index, { dimensionId })
                      }
                    />
                    <Alert
                      style={{ marginTop: 12 }}
                      type="info"
                      showIcon
                      message="多行文字反馈，最多 2000 字，不参与任何评分"
                    />
                  </>
                )}
                {question.type === "evaluation_text" && (
                  <Space style={{ marginTop: 12 }}>
                    <Checkbox
                      checked={question.required}
                      disabled={readonly}
                      onChange={(event) =>
                        updateQuestion(index, {
                          required: event.target.checked,
                        })
                      }
                    >
                      必答
                    </Checkbox>
                  </Space>
                )}
              </Card>
            ))}
            {!readonly && (
              <Space.Compact block>
                <Button block type="dashed" onClick={addScoreQuestion}>
                  添加评分题
                </Button>
                <Button block type="dashed" onClick={addTextQuestion}>
                  添加填空题
                </Button>
              </Space.Compact>
            )}
          </div>
        </div>
      )}
      <Modal
        title="新建环评模板"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={createTemplate}
      >
        <Input
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          placeholder="如：2026 价值观环评模板"
        />
      </Modal>
    </div>
  );
}

function EvalScoreQuestionEditor({
  question,
  dimensions,
  readonly,
  onChange,
}: {
  question: EvalScoreQuestion;
  dimensions: EvalTemplate["dimensions"];
  readonly: boolean;
  onChange: (patch: Partial<EvalScoreQuestion>) => void;
}) {
  const requiredScores = question.caseRequiredScores || [];

  function setCaseRequired(score: number, checked: boolean) {
    const nextScores = checked
      ? Array.from(new Set([...requiredScores, score])).sort((a, b) => a - b)
      : requiredScores.filter((item) => item !== score);
    onChange({ caseRequiredScores: nextScores });
  }

  return (
    <div className="eval-score-editor">
      <section className="eval-score-editor-section">
        <div className="eval-score-editor-section-heading">
          <Typography.Text strong>题目内容</Typography.Text>
          <Typography.Text type="secondary">
            员工填写端会按此内容展示
          </Typography.Text>
        </div>
        <div className="eval-score-editor-fields">
          <div className="eval-score-editor-field eval-score-editor-field-full">
            <span>
              <span className="eval-score-editor-required">*</span> 题目标题
            </span>
            <Input
              aria-label="题目标题"
              value={question.label}
              disabled={readonly}
              placeholder="请输入评分题标题"
              onChange={(event) => onChange({ label: event.target.value })}
            />
          </div>
          <div className="eval-score-editor-field eval-score-editor-field-full">
            <span>补充说明</span>
            <Input.TextArea
              aria-label="补充说明"
              autoSize={{ minRows: 2, maxRows: 4 }}
              value={question.description}
              disabled={readonly}
              placeholder="补充评分口径或填写说明（可选）"
              onChange={(event) =>
                onChange({ description: event.target.value })
              }
            />
          </div>
          <div className="eval-score-editor-field">
            <span>所属维度</span>
            <Select
              aria-label="所属维度"
              value={question.dimensionId}
              disabled={readonly}
              options={dimensions.map((dimension) => ({
                label: dimension.name,
                value: dimension.id,
              }))}
              onChange={(dimensionId) => onChange({ dimensionId })}
            />
          </div>
          <div className="eval-score-editor-field">
            <span>题型</span>
            <Input aria-label="题型" value="评分单选题" disabled />
          </div>
        </div>
      </section>

      <section className="eval-score-editor-section">
        <div className="eval-score-editor-section-heading">
          <Typography.Text strong>评分行为选项</Typography.Text>
          <Typography.Text type="secondary">
            分值固定为 0–5 分，只需编辑行为描述
          </Typography.Text>
        </div>
        <div className="eval-score-editor-option-heading" aria-hidden="true">
          <span>分值</span>
          <span>行为描述</span>
          <span>案例要求</span>
        </div>
        <div className="eval-score-editor-options">
          {question.options.map((option, optionIndex) => {
            const requiresCase = requiredScores.includes(option.score);
            return (
              <div
                className={`eval-score-editor-option ${requiresCase ? "requires-case" : ""}`}
                key={option.score}
              >
                <span className="eval-score-editor-badge">
                  {option.score} 分
                </span>
                <Input
                  aria-label={`${option.score} 分行为描述`}
                  value={option.label}
                  disabled={readonly}
                  placeholder="请输入该分值对应的行为描述"
                  onChange={(event) =>
                    onChange({
                      options: question.options.map((item, i) =>
                        i === optionIndex
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
                <Checkbox
                  checked={requiresCase}
                  disabled={readonly}
                  onChange={(event) =>
                    setCaseRequired(option.score, event.target.checked)
                  }
                >
                  必须填案例
                </Checkbox>
              </div>
            );
          })}
        </div>
      </section>

      <section className="eval-score-editor-section">
        <div className="eval-score-editor-section-heading">
          <Typography.Text strong>案例填写设置</Typography.Text>
        </div>
        <div className="eval-score-editor-case-settings">
          <div className="eval-score-editor-field">
            <span>案例输入提示</span>
            <Input
              aria-label="案例输入提示"
              value={question.casePrompt}
              disabled={readonly}
              placeholder="请填写具体案例"
              onChange={(event) => onChange({ casePrompt: event.target.value })}
            />
          </div>
          <Alert
            type="info"
            showIcon
            message={
              requiredScores.length
                ? `已设置：${requiredScores.join("、")} 分必须填写案例`
                : "当前没有分值要求填写案例"
            }
          />
        </div>
      </section>
    </div>
  );
}

function CompactGroupTags({
  groups,
  fallback,
}: {
  groups: Array<{
    id: number;
    path: string;
    primary: boolean;
    enabled: boolean;
  }>;
  fallback?: string | null;
}) {
  const visibleGroups = groups.filter((group) => group.enabled);
  if (!visibleGroups.length) {
    return (
      <Typography.Text type="secondary">{fallback || "未归组"}</Typography.Text>
    );
  }
  const shown = visibleGroups.slice(0, 3);
  const hidden = visibleGroups.slice(3);
  return (
    <Space size={[4, 4]} wrap>
      {shown.map((group) => (
        <Tooltip title={group.path} key={group.id}>
          <Tag color={group.primary ? "green" : "blue"}>
            {group.primary ? "主" : "兼"}·
            {group.path.split("/")[group.path.split("/").length - 1]}
          </Tag>
        </Tooltip>
      ))}
      {hidden.length > 0 && (
        <Tooltip title={hidden.map((group) => group.path).join("、")}>
          <Tag>+{hidden.length}</Tag>
        </Tooltip>
      )}
    </Space>
  );
}

function EvalPeopleTab({ cycle }: { cycle: Cycle }) {
  const [relationRevision, setRelationRevision] = useState(0);
  const notifyRelationsChanged = () => {
    setRelationRevision((revision) => revision + 1);
  };

  return (
    <Tabs
      items={[
        {
          key: "participants",
          label: "参评人员",
          children: (
            <EvalParticipantsTab cycle={cycle} refreshKey={relationRevision} />
          ),
        },
        {
          key: "special",
          label: "特殊人员",
          children: <EvalSpecialParticipantsTab cycle={cycle} />,
        },
        {
          key: "review",
          label: "关系复核",
          children: (
            <div>
              <GenerateTab
                cycleId={cycle.id}
                onRelationsChanged={notifyRelationsChanged}
              />
              <Divider />
              <ReviewTab cycleId={cycle.id} refreshKey={relationRevision} />
              <Divider />
              <RelationsTab
                cycleId={cycle}
                refreshKey={relationRevision}
                onRelationsChanged={notifyRelationsChanged}
              />
            </div>
          ),
        },
      ]}
    />
  );
}

function EvalParticipantsTab({
  cycle,
  refreshKey = 0,
}: {
  cycle: Cycle;
  refreshKey?: number;
}) {
  const { message } = AntApp.useApp();
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [departments, setDepartments] = useState<
    Array<{ id: number; name: string; path: string; count: number }>
  >([]);
  const [participants, setParticipants] = useState<EvalParticipantLite[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<ParticipantPreview | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [sourceCycleId, setSourceCycleId] = useState<number>();
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [adjusting, setAdjusting] = useState<EvalParticipantLite | null>(null);
  const [groupDraft, setGroupDraft] = useState<Record<number, boolean>>({});
  const [groupSaving, setGroupSaving] = useState(false);
  const readonly = cycle.status !== "draft";

  async function load() {
    const [candidateResponse, participantResponse] = await Promise.all([
      http.get("/admin/eval/participant-candidates"),
      http.get(`/admin/eval/cycles/${cycle.id}/participants`),
    ]);
    setContacts(candidateResponse.data.contacts || []);
    setDepartments(candidateResponse.data.departments || []);
    setParticipants((participantResponse.data || []) as EvalParticipantLite[]);
    setSelectedIds(
      (participantResponse.data || []).map(
        (participant: EvalParticipantLite) => participant.contactId,
      ),
    );
  }
  useEffect(() => {
    load();
    http
      .get("/admin/eval/cycles")
      .then((response) =>
        setCycles(
          (response.data || []).filter((item: Cycle) => item.id !== cycle.id),
        ),
      );
  }, [cycle.id, refreshKey]);

  const participantByContactId = useMemo(
    () =>
      new Map(
        participants.map((participant) => [participant.contactId, participant]),
      ),
    [participants],
  );
  const relationsNeedRegeneration = participants.some(
    (participant) => participant.relationsNeedRegeneration,
  );

  function selectDepartments(values: number[]) {
    setSelectedDepartments(values);
    setSelectedIds(
      contacts
        .filter((contact) =>
          (contact.memberships || []).some((membership) =>
            values.includes(membership.departmentId),
          ),
        )
        .map((contact) => contact.id),
    );
  }

  async function previewSelection() {
    if (!selectedIds.length) return message.warning("请至少选择一名参评人员");
    setPreviewLoading(true);
    try {
      const { data } = await http.post(
        `/admin/eval/cycles/${cycle.id}/participants/preview`,
        { contactIds: selectedIds },
      );
      setPreview(data);
    } catch (error: any) {
      const detail = error.response?.data?.message;
      message.error(
        Array.isArray(detail) ? detail.join("；") : detail || "预览失败",
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await http.put(`/admin/eval/cycles/${cycle.id}/participants`, {
        contactIds: selectedIds,
      });
      message.success(`已生成 ${selectedIds.length} 人的批次快照`);
      setPreview(null);
      await load();
    } catch (error: any) {
      const detail = error.response?.data?.message;
      message.error(
        Array.isArray(detail) ? detail.join("；") : detail || "保存失败",
      );
    } finally {
      setSaving(false);
    }
  }

  async function copyPrevious() {
    if (!sourceCycleId) return message.warning("请选择来源批次");
    try {
      await http.post(`/admin/eval/cycles/${cycle.id}/participants/copy`, {
        sourceCycleId,
      });
      message.success("已复制上一批次人员范围");
      setCopyOpen(false);
      await load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "复制失败");
    }
  }

  function openGroupDrawer(participant: EvalParticipantLite) {
    setAdjusting(participant);
    setGroupDraft(
      Object.fromEntries(
        (participant.groups || []).map((group) => [
          group.departmentId,
          group.evalEnabled,
        ]),
      ),
    );
  }

  async function saveGroupChanges() {
    if (!adjusting) return;
    setGroupSaving(true);
    try {
      await http.put(
        `/admin/eval/cycles/${cycle.id}/participants/${adjusting.id}/groups`,
        {
          groups: adjusting.groups.map((group) => ({
            departmentId: group.departmentId,
            evalEnabled: group.isPrimarySnapshot
              ? true
              : Boolean(groupDraft[group.departmentId]),
          })),
        },
      );
      message.success("当期互评小组已更新，请重新生成评价关系");
      setAdjusting(null);
      await load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "小组调整失败");
    } finally {
      setGroupSaving(false);
    }
  }

  function candidateGroups(contact: ContactLite) {
    return (contact.memberships || []).map((membership) => ({
      id: membership.departmentId,
      path: membership.departmentPath,
      primary: membership.isPrimary,
      enabled: true,
    }));
  }

  function participantGroups(participant: EvalParticipantLite) {
    return (participant.groups || []).map((group) => ({
      id: group.departmentId,
      path: group.departmentPathSnapshot,
      primary: group.isPrimarySnapshot,
      enabled: group.evalEnabled,
    }));
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="候选人直接来自联系人模块。保存后形成当前批次快照，联系人后续变更不会静默改写本批次。"
      />
      {relationsNeedRegeneration && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="人员范围或当期小组已变化，需要到“关系复核”重新生成评价关系"
        />
      )}
      {!readonly && (
        <Card className="eval-toolbar-card">
          <Space wrap>
            <Select
              mode="multiple"
              style={{ minWidth: 360 }}
              placeholder="按部门/组选择"
              value={selectedDepartments}
              options={departments.map((department) => ({
                label: `${department.path}（${department.count} 人）`,
                value: department.id,
              }))}
              onChange={selectDepartments}
            />
            <Button onClick={() => setCopyOpen(true)}>复制上一批次</Button>
            <Button
              type="primary"
              loading={previewLoading}
              onClick={previewSelection}
            >
              确认人员范围（{selectedIds.length} 人）
            </Button>
          </Space>
        </Card>
      )}
      <Table
        rowKey="id"
        dataSource={contacts}
        rowSelection={
          readonly
            ? undefined
            : {
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds(keys as number[]),
              }
        }
        pagination={{
          defaultPageSize: 15,
          showSizeChanger: true,
          pageSizeOptions: [10, 15, 20, 50, 100],
        }}
        columns={[
          { title: "姓名", dataIndex: "name" },
          {
            title: "部门归属 / 当期互评小组",
            render: (_value, row) => {
              const participant = participantByContactId.get(row.id);
              return (
                <CompactGroupTags
                  groups={
                    participant
                      ? participantGroups(participant)
                      : candidateGroups(row)
                  }
                  fallback={row.department}
                />
              );
            },
          },
          {
            title: "职位",
            dataIndex: "position",
            render: (value) => value || "—",
          },
          {
            title: "快照状态",
            render: (_value, row) =>
              participants.some(
                (participant) => participant.contactId === row.id,
              ) ? (
                <Tag color="green">已加入</Tag>
              ) : (
                <Tag>未加入</Tag>
              ),
          },
          {
            title: "操作",
            width: 120,
            render: (_value, row) => {
              const participant = participantByContactId.get(row.id);
              return participant ? (
                <Button
                  type="link"
                  disabled={readonly || !participant.groups?.length}
                  onClick={() => openGroupDrawer(participant)}
                >
                  调整小组
                </Button>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              );
            },
          },
        ]}
      />
      <Modal
        title="确认本批次人员与互评小组"
        open={!!preview}
        width={720}
        okText="确认并生成快照"
        cancelText="返回调整"
        confirmLoading={saving}
        onCancel={() => setPreview(null)}
        onOk={save}
      >
        {preview && (
          <div className="eval-participant-preview">
            <Alert
              type="warning"
              showIcon
              message="确认后将替换本批次人员快照，原自动关系需要重新生成；有效人工关系会保留。"
            />
            <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
              <Col span={6}>
                <Statistic
                  title="参评人员"
                  value={preview.participantCount}
                  suffix="人"
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="开启小组"
                  value={preview.enabledGroupCount}
                  suffix="个"
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="多小组人员"
                  value={preview.multiGroupParticipantCount}
                  suffix="人"
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="单人小组"
                  value={preview.singlePersonGroupCount}
                  suffix="个"
                />
              </Col>
            </Row>
            {preview.singlePersonGroups.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Typography.Text strong>需要关注的单人小组</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Space size={[4, 6]} wrap>
                    {preview.singlePersonGroups.map((group) => (
                      <Tag color="orange" key={group.departmentId}>
                        {group.path}
                      </Tag>
                    ))}
                  </Space>
                </div>
              </div>
            )}
            {preview.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={`${preview.warnings.length} 条组织归属提示`}
                description={
                  <div className="eval-preview-warning-list">
                    {preview.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                }
              />
            )}
          </div>
        )}
      </Modal>
      <Modal
        title="复制上一批次人员范围"
        open={copyOpen}
        onCancel={() => setCopyOpen(false)}
        onOk={copyPrevious}
      >
        <Select
          style={{ width: "100%" }}
          value={sourceCycleId}
          onChange={setSourceCycleId}
          placeholder="选择来源批次"
          options={cycles.map((item) => ({
            label: `${item.name}（${item.participantCount || 0} 人）`,
            value: item.id,
          }))}
        />
      </Modal>
      <Drawer
        width={520}
        title={
          adjusting ? `${adjusting.nameSnapshot} · 当期互评小组` : "调整小组"
        }
        open={!!adjusting}
        onClose={() => setAdjusting(null)}
        extra={
          <Space>
            <Button onClick={() => setAdjusting(null)}>取消</Button>
            <Button
              type="primary"
              loading={groupSaving}
              disabled={readonly}
              onClick={saveGroupChanges}
            >
              保存当期设置
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          message="这里只调整当前环评批次，不会修改通讯录中的部门归属和默认开关。"
        />
        <div className="eval-membership-rail">
          {(adjusting?.groups || []).map((group) => (
            <div
              className={`eval-membership-rail-item${
                group.isPrimarySnapshot ? " is-primary" : ""
              }`}
              key={group.departmentId}
            >
              <div className="eval-membership-rail-marker" />
              <div className="eval-membership-rail-content">
                <Space size={6} wrap>
                  <Tag color={group.isPrimarySnapshot ? "green" : "blue"}>
                    {group.isPrimarySnapshot ? "主部门" : "兼任部门"}
                  </Tag>
                  {group.roleNameSnapshot && (
                    <Tag>{group.roleNameSnapshot}</Tag>
                  )}
                </Space>
                <Typography.Text
                  strong
                  style={{ display: "block", marginTop: 8 }}
                >
                  {group.departmentPathSnapshot}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {group.isPrimarySnapshot
                    ? "主部门固定参加本批次互评"
                    : groupDraft[group.departmentId]
                      ? "参加本批次互评"
                      : "仅保留部门归属，不参加本批次互评"}
                </Typography.Text>
              </div>
              <Switch
                checked={
                  group.isPrimarySnapshot ||
                  Boolean(groupDraft[group.departmentId])
                }
                disabled={readonly || group.isPrimarySnapshot}
                onChange={(checked) =>
                  setGroupDraft((current) => ({
                    ...current,
                    [group.departmentId]: checked,
                  }))
                }
              />
            </div>
          ))}
        </div>
      </Drawer>
    </div>
  );
}

function EvalSpecialParticipantsTab({ cycle }: { cycle: Cycle }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<any[]>([]);
  const readonly = cycle.status !== "draft";
  const load = () =>
    http
      .get(`/admin/eval/cycles/${cycle.id}/participants`)
      .then((response) => setRows(response.data || []));
  useEffect(() => {
    load();
  }, [cycle.id]);
  async function setMode(row: any, mode: string) {
    try {
      await http.put(`/admin/eval/cycles/${cycle.id}/participants/${row.id}`, {
        mode,
      });
      message.success(
        mode === "special" ? "已设为特殊人员" : "已恢复为普通人员",
      );
      load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "操作失败");
    }
  }
  async function togglePeerExempt(row: any) {
    try {
      await http.put(`/admin/eval/cycles/${cycle.id}/participants/${row.id}`, {
        peerExempt: !row.peerExempt,
        exceptionReason: row.peerExempt ? "" : "管理员确认本批次无需他评",
      });
      message.success(row.peerExempt ? "已取消他评豁免" : "已登记他评豁免");
      load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "操作失败");
    }
  }
  return (
    <Table
      rowKey="id"
      dataSource={rows}
      pagination={false}
      columns={[
        { title: "姓名", dataIndex: "nameSnapshot" },
        {
          title: "当期互评小组",
          render: (_value, row) => (
            <CompactGroupTags
              groups={(row.groups || []).map(
                (group: ParticipantGroupSnapshotLite) => ({
                  id: group.departmentId,
                  path: group.departmentPathSnapshot,
                  primary: group.isPrimarySnapshot,
                  enabled: group.evalEnabled,
                }),
              )}
              fallback={row.groupName}
            />
          ),
        },
        {
          title: "类型",
          dataIndex: "mode",
          render: (mode) =>
            mode === "special" ? (
              <Tag color="gold">特殊人员</Tag>
            ) : (
              <Tag color="blue">普通人员</Tag>
            ),
        },
        {
          title: "他评要求",
          render: (_value, row) =>
            row.peerExempt ? (
              <Tag>已豁免</Tag>
            ) : (
              <Tag color="green">需他评</Tag>
            ),
        },
        {
          title: "说明",
          render: (_value, row) =>
            row.mode === "special"
              ? "不进入组内自动关系，需要人工配置"
              : "进入本组自评和互评网络",
        },
        {
          title: "操作",
          width: 230,
          render: (_value, row) => (
            <Space>
              <Button
                type="link"
                disabled={readonly}
                onClick={() =>
                  setMode(row, row.mode === "special" ? "normal" : "special")
                }
              >
                {row.mode === "special" ? "恢复普通" : "设为特殊"}
              </Button>
              <Button
                type="link"
                disabled={readonly}
                onClick={() => togglePeerExempt(row)}
              >
                {row.peerExempt ? "取消豁免" : "豁免他评"}
              </Button>
            </Space>
          ),
        },
      ]}
    />
  );
}

function EvalExecutionTab({
  cycle,
  fillUrl,
}: {
  cycle: Cycle;
  fillUrl: string;
}) {
  return (
    <Tabs
      items={[
        {
          key: "progress",
          label: "评估进度",
          children: <EvalProgressPanel cycle={cycle} />,
        },
        {
          key: "preview",
          label: "填写端预览",
          children: (
            <Card>
              <Alert
                type="info"
                showIcon
                message="员工登录后只看到以自己为评价人的任务，不会看到自己的汇总结果或他人身份。"
              />
              <Descriptions
                bordered
                column={1}
                style={{ marginTop: 18 }}
                items={[
                  { key: "entry", label: "统一入口", children: fillUrl },
                  {
                    key: "time",
                    label: "填写时间",
                    children:
                      cycle.startAt && cycle.endAt
                        ? `${new Date(cycle.startAt).toLocaleString()} 至 ${new Date(cycle.endAt).toLocaleString()}`
                        : "尚未配置",
                  },
                  {
                    key: "rule",
                    label: "案例规则",
                    children: "每题始终显示案例栏；命中模板勾选分值时强制填写",
                  },
                ]}
              />
              <Button
                type="primary"
                style={{ marginTop: 18 }}
                onClick={() => window.open(fillUrl, "_blank")}
              >
                打开填写端
              </Button>
            </Card>
          ),
        },
      ]}
    />
  );
}

function EvalProgressPanel({ cycle }: { cycle: Cycle }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setData((await http.get(`/admin/eval/cycles/${cycle.id}/overview`)).data);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [cycle.id]);
  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={load} loading={loading}>
          刷新进度
        </Button>
        <Typography.Text type="secondary">
          提醒功能首期提供名单查看，不接第三方消息渠道。
        </Typography.Text>
      </Space>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="被评估人数" value={data?.participantCount || 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="完成人数"
              value={data?.completedRateeCount || 0}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="已提交/总任务"
              value={data ? `${data.submittedTasks}/${data.totalTasks}` : "0/0"}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="完成率"
              value={(data?.completionRate || 0) * 100}
              precision={1}
              suffix="%"
            />
          </Card>
        </Col>
      </Row>
      <Table
        style={{ marginTop: 18 }}
        rowKey="groupName"
        dataSource={data?.groups || []}
        pagination={false}
        columns={[
          { title: "评价小组", dataIndex: "groupName" },
          { title: "参评人数", dataIndex: "participantCount" },
          {
            title: "任务进度",
            render: (_value: unknown, row: any) =>
              `${row.submittedTasks}/${row.totalTasks}`,
          },
          {
            title: "完成率",
            dataIndex: "completionRate",
            render: (value) => `${(Number(value) * 100).toFixed(1)}%`,
          },
        ]}
      />
    </div>
  );
}

function EvalReportsTab({ cycle }: { cycle: Cycle }) {
  return (
    <Tabs
      items={[
        {
          key: "results",
          label: "评价数据",
          children: <EvalResultsPanel cycle={cycle} />,
        },
        {
          key: "raw",
          label: "原始数据",
          children: <EvalRawResponsesPanel cycle={cycle} />,
        },
      ]}
    />
  );
}

function EvalResultsPanel({ cycle }: { cycle: Cycle }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [progress, setProgress] = useState<EvalRaterProgress | null>(null);
  const [progressLoadingContactId, setProgressLoadingContactId] = useState<
    number | null
  >(null);
  const load = async () => {
    setLoading(true);
    try {
      setRows(
        (await http.get(`/admin/eval/cycles/${cycle.id}/results`)).data || [],
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [cycle.id]);
  async function openReport(contactId: number) {
    try {
      setReport(
        (await http.get(`/admin/eval/cycles/${cycle.id}/results/${contactId}`))
          .data,
      );
    } catch (error: any) {
      message.error(error.response?.data?.message || "报告加载失败");
    }
  }
  async function openProgress(contactId: number) {
    setProgressLoadingContactId(contactId);
    try {
      setProgress(
        (
          await http.get(
            `/admin/eval/cycles/${cycle.id}/progress/${contactId}`,
          )
        ).data,
      );
    } catch (error: any) {
      message.error(error.response?.data?.message || "评价进度加载失败");
    } finally {
      setProgressLoadingContactId(null);
    }
  }
  const dimensions = useMemo(() => {
    const names = new Map<string, string>();
    rows.forEach((row) =>
      ((row.result?.dimensionScoresJson || []) as any[]).forEach((dimension) =>
        names.set(dimension.dimensionId, dimension.name),
      ),
    );
    return Array.from(names, ([id, name]) => ({ id, name }));
  }, [rows]);
  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={load}>重新计算暂定结果</Button>
        <Button
          onClick={() =>
            downloadFile(
              `/admin/eval/cycles/${cycle.id}/export`,
              `环评结果-${cycle.name}.xlsx`,
            )
          }
        >
          导出结果
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 900 }}
        columns={[
          { title: "被评人", dataIndex: "nameSnapshot", fixed: "left" },
          { title: "小组", dataIndex: "groupName" },
          {
            title: "已收/应收",
            render: (_value, row) =>
              `${row.result?.receivedCount || 0}/${row.result?.expectedCount || 0}`,
          },
          {
            title: "总得分",
            render: (_value, row) =>
              row.result?.totalScore === null ||
              row.result?.totalScore === undefined ? (
                <Typography.Text type="secondary">暂无评分</Typography.Text>
              ) : (
                Number(row.result.totalScore).toFixed(2)
              ),
          },
          ...dimensions.map((dimension) => ({
            title: dimension.name,
            render: (_value: unknown, row: any) => {
              const item = (row.result?.dimensionScoresJson || []).find(
                (value: any) => value.dimensionId === dimension.id,
              );
              return item?.score === null || item?.score === undefined
                ? "—"
                : Number(item.score).toFixed(2);
            },
          })),
          {
            title: "结果状态",
            render: (_value, row) => (
              <Tag
                color={row.result?.resultStatus === "final" ? "purple" : "blue"}
              >
                {row.result?.resultStatus === "final" ? "最终" : "暂定"}
              </Tag>
            ),
          },
          {
            title: "操作",
            fixed: "right",
            render: (_value, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  loading={progressLoadingContactId === row.contactId}
                  onClick={() => openProgress(row.contactId)}
                >
                  进度查看
                </Button>
                <Button type="link" onClick={() => openReport(row.contactId)}>
                  查看报告
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <EvalRaterProgressModal
        progress={progress}
        onClose={() => setProgress(null)}
      />
      <Drawer
        width={720}
        title={
          report ? `${report.participant.nameSnapshot} · 个人报告` : "个人报告"
        }
        open={!!report}
        onClose={() => setReport(null)}
      >
        {report && <EvalReportContent report={report} />}
      </Drawer>
    </div>
  );
}

function EvalRaterProgressModal({
  progress,
  onClose,
}: {
  progress: EvalRaterProgress | null;
  onClose: () => void;
}) {
  const percentOf = (value: number | null) =>
    value === null ? null : Math.round(value * 10000) / 100;
  const renderPeople = (
    people: EvalProgressPerson[],
    state: "completed" | "pending",
  ) => {
    if (!people.length)
      return <Typography.Text type="secondary">—</Typography.Text>;
    return (
      <div className="eval-progress-person-list">
        {people.map((person) => {
          const sourceText = person.sharedGroups.length
            ? `互评小组：${person.sharedGroups.map((group) => group.path).join("；")}`
            : person.source === "manual"
              ? "来源：人工配置"
              : person.source === "auto"
                ? "来源：自动生成"
                : "";
          return (
            <Tooltip key={person.relationId} title={sourceText || undefined}>
              <Tag
                className={`eval-progress-person-tag is-${state}`}
                color={state === "completed" ? "cyan" : "orange"}
              >
                {person.name}
              </Tag>
            </Tooltip>
          );
        })}
      </div>
    );
  };

  return (
    <Modal
      width={920}
      title={progress ? `${progress.participant.name} · 评价进度` : "评价进度"}
      open={!!progress}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      className="eval-progress-modal"
    >
      {progress && (
        <div className="eval-progress-content">
          <div className="eval-progress-summary">
            <div className="eval-progress-summary-item">
              <Typography.Text type="secondary">应评价</Typography.Text>
              <strong>{progress.summary.total}</strong>
            </div>
            <div className="eval-progress-summary-item is-completed">
              <Typography.Text type="secondary">已完成</Typography.Text>
              <strong>{progress.summary.completed}</strong>
            </div>
            <div className="eval-progress-summary-item is-pending">
              <Typography.Text type="secondary">未完成</Typography.Text>
              <strong>{progress.summary.pending}</strong>
            </div>
            <div className="eval-progress-summary-item">
              <Typography.Text type="secondary">完成率</Typography.Text>
              <strong>
                {progress.summary.completionRate === null
                  ? "—"
                  : `${percentOf(progress.summary.completionRate)}%`}
              </strong>
            </div>
          </div>

          {progress.summary.total ? (
            <Table
              className="eval-progress-table"
              rowKey="type"
              size="middle"
              pagination={false}
              dataSource={progress.groups}
              scroll={{ x: 760, y: 420 }}
              columns={[
                {
                  title: "评价任务",
                  dataIndex: "label",
                  width: 110,
                  render: (label: string, group: EvalProgressGroup) => (
                    <div className="eval-progress-type-cell">
                      <strong>{label}</strong>
                      <Typography.Text type="secondary">
                        {group.total} 项
                      </Typography.Text>
                    </div>
                  ),
                },
                {
                  title: "完成率",
                  width: 150,
                  render: (_value: unknown, group: EvalProgressGroup) => {
                    const percent = percentOf(group.completionRate);
                    return percent === null ? (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ) : (
                      <Progress
                        percent={percent}
                        size="small"
                        strokeColor="#4f6ef7"
                        trailColor="#eef1f6"
                      />
                    );
                  },
                },
                {
                  title: "已评价",
                  render: (_value: unknown, group: EvalProgressGroup) =>
                    renderPeople(group.completed, "completed"),
                },
                {
                  title: "未评价",
                  render: (_value: unknown, group: EvalProgressGroup) =>
                    renderPeople(group.pending, "pending"),
                },
              ]}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="该员工当前没有评价任务"
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function EvalReportContent({ report }: { report: any }) {
  const result = report.result;
  const feedbackGroups = Array.from(
    (report.textFeedback || [])
      .reduce((groups: Map<string, any>, item: any) => {
        const key = `${item.dimensionId}:${item.questionId}`;
        const group = groups.get(key) || {
          key,
          dimensionName: item.dimensionName,
          questionLabel: item.questionLabel,
          items: [],
        };
        group.items.push(item);
        groups.set(key, group);
        return groups;
      }, new Map<string, any>())
      .values(),
  );
  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Card>
            <Statistic
              title="总得分"
              value={
                result?.totalScore === null || result?.totalScore === undefined
                  ? "暂无"
                  : Number(result.totalScore).toFixed(2)
              }
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="已收/应收"
              value={`${result?.receivedCount || 0}/${result?.expectedCount || 0}`}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="结果状态"
              value={result?.resultStatus === "final" ? "最终" : "暂定"}
            />
          </Card>
        </Col>
      </Row>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        维度得分
      </Typography.Title>
      <Table
        size="small"
        pagination={false}
        rowKey="dimensionId"
        dataSource={result?.dimensionScoresJson || []}
        columns={[
          { title: "维度", dataIndex: "name" },
          {
            title: "得分",
            dataIndex: "score",
            render: (value) =>
              value === null ? "暂无评分" : Number(value).toFixed(2),
          },
        ]}
      />
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        逐题得分
      </Typography.Title>
      <Table
        size="small"
        pagination={false}
        rowKey="questionId"
        dataSource={result?.questionScoresJson || []}
        columns={[
          { title: "题目", dataIndex: "label" },
          { title: "自评", dataIndex: "selfScore", render: scoreText },
          { title: "他评平均", dataIndex: "otherScore", render: scoreText },
          { title: "综合", dataIndex: "score", render: scoreText },
          { title: "有效答案", dataIndex: "answerCount" },
        ]}
      />
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        案例说明
      </Typography.Title>
      {!report.cases?.length ? (
        <Empty description="暂无案例说明" />
      ) : (
        report.cases.map((item: any, index: number) => (
          <Card
            size="small"
            key={`${item.questionId}-${index}`}
            style={{ marginBottom: 10 }}
          >
            <Tag>{TYPE_LABEL[item.relationType] || item.relationType}</Tag>
            <Tag color="blue">{item.score} 分</Tag>
            <Typography.Text strong>{item.questionLabel}</Typography.Text>
            <div style={{ marginTop: 8 }}>{item.caseText}</div>
          </Card>
        ))
      )}
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        文字反馈
      </Typography.Title>
      {!feedbackGroups.length ? (
        <Empty description="暂无文字反馈" />
      ) : (
        feedbackGroups.map((group: any) => (
          <Card
            size="small"
            key={group.key}
            title={`${group.dimensionName || "未分组"} · ${group.questionLabel}`}
            style={{ marginBottom: 12 }}
          >
            {group.items.map((item: any, index: number) => (
              <div
                key={`${item.questionId}-${index}`}
                style={{
                  marginBottom: index === group.items.length - 1 ? 0 : 12,
                }}
              >
                <Tag color="cyan">
                  {item.relationType === "peer"
                    ? "同事"
                    : TYPE_LABEL[item.relationType] || item.relationType}
                </Tag>
                <span style={{ whiteSpace: "pre-wrap" }}>{item.text}</span>
              </div>
            ))}
          </Card>
        ))
      )}
    </div>
  );
}

function scoreText(value: unknown) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(2);
}

function EvalRawResponsesPanel({ cycle }: { cycle: Cycle }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setRows(
        (await http.get(`/admin/eval/cycles/${cycle.id}/responses`)).data || [],
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [cycle.id]);
  async function invalidate(row: any) {
    const reason = window.prompt("请输入作废原因");
    if (!reason?.trim()) return;
    try {
      await http.post(`/admin/eval/responses/${row.id}/invalidate`, { reason });
      message.success("答卷已作废，可由员工重新填写");
      load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "作废失败");
    }
  }
  async function restore(row: any) {
    try {
      await http.post(`/admin/eval/responses/${row.id}/restore`);
      message.success("答卷已恢复");
      load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "恢复失败");
    }
  }
  return (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={rows}
      scroll={{ x: 1000 }}
      expandable={{
        expandedRowRender: (row) => (
          <pre className="eval-json-preview">
            {JSON.stringify(row.answersJson, null, 2)}
          </pre>
        ),
      }}
      columns={[
        { title: "答卷编号", dataIndex: "id" },
        {
          title: "评价人",
          render: (_value, row) => row.relation?.raterName || "—",
        },
        {
          title: "被评人",
          render: (_value, row) => row.relation?.rateeName || "—",
        },
        {
          title: "关系",
          render: (_value, row) =>
            TYPE_LABEL[row.relation?.relationType] ||
            row.relation?.relationType,
        },
        {
          title: "提交时间",
          dataIndex: "submittedAt",
          render: (value) => new Date(value).toLocaleString(),
        },
        {
          title: "有效状态",
          dataIndex: "validStatus",
          render: (value) => (
            <Tag color={value === "valid" ? "green" : "red"}>
              {value === "valid" ? "有效" : "已作废"}
            </Tag>
          ),
        },
        {
          title: "操作",
          fixed: "right",
          render: (_value, row) =>
            row.validStatus === "valid" ? (
              <Button
                type="link"
                danger
                disabled={["locked", "archived"].includes(cycle.status)}
                onClick={() => invalidate(row)}
              >
                作废
              </Button>
            ) : (
              <Button
                type="link"
                disabled={["locked", "archived"].includes(cycle.status)}
                onClick={() => restore(row)}
              >
                恢复
              </Button>
            ),
        },
      ]}
    />
  );
}

// ============ 旧版批次详情（只读兼容原三模板流程）============
function LegacyEvalCycleDetail() {
  const { id } = useParams();
  const cycleId = Number(id);
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [relationRevision, setRelationRevision] = useState(0);
  const fillUrl = `${location.origin}/eval-fill`;

  const notifyRelationsChanged = () => {
    setRelationRevision((revision) => revision + 1);
  };

  async function loadCycle() {
    const { data } = await http.get(`/admin/eval/cycles/${cycleId}`);
    setCycle(data);
  }
  useEffect(() => {
    loadCycle();
  }, [cycleId]);

  function copyLink() {
    navigator.clipboard
      ?.writeText(fillUrl)
      .then(() => message.success("链接已复制"))
      .catch(() => message.warning("复制失败，请手动复制"));
  }

  async function handleExport() {
    try {
      await downloadFile(
        `/admin/eval/cycles/${cycleId}/export`,
        `环评结果-批次${cycleId}.xlsx`,
      );
    } catch (e: any) {
      message.error("导出失败");
    }
  }

  if (!cycle) return null;

  return (
    <Card
      title={
        <Space>
          <Button type="link" onClick={() => navigate("/eval")}>
            ← 返回
          </Button>
          {cycle.name}
          <Tag color={STATUS_LABEL[cycle.status]?.color}>
            {STATUS_LABEL[cycle.status]?.text || cycle.status}
          </Tag>
        </Space>
      }
      extra={
        <Space>
          <Button type="primary" onClick={() => setShareOpen(true)}>
            分享给员工
          </Button>
          <Button onClick={handleExport}>导出结果 CSV</Button>
        </Space>
      }
    >
      <Modal
        title="分享给员工填写"
        open={shareOpen}
        onCancel={() => setShareOpen(false)}
        footer={null}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="整个批次只有这一个入口链接，发给全组人即可。员工用企业微信打开/扫码登录后，只会看到分配给自己的自评 + 他评。"
        />
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <QRCode value={fillUrl} size={180} />
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input readOnly value={fillUrl} />
          <Button onClick={copyLink}>复制</Button>
        </Space.Compact>
      </Modal>
      <Tabs
        defaultActiveKey="config"
        items={[
          {
            key: "config",
            label: "① 配置",
            children: <ConfigTab cycle={cycle} onSaved={loadCycle} />,
          },
          {
            key: "generate",
            label: "② 生成关系",
            children: (
              <GenerateTab
                cycleId={cycleId}
                onRelationsChanged={notifyRelationsChanged}
              />
            ),
          },
          {
            key: "review",
            label: "③ 复核列表",
            children: (
              <ReviewTab cycleId={cycleId} refreshKey={relationRevision} />
            ),
          },
          {
            key: "relations",
            label: "④ 关系明细 / 人工配置",
            children: (
              <RelationsTab
                cycleId={cycle}
                refreshKey={relationRevision}
                onRelationsChanged={notifyRelationsChanged}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}

function ConfigTab({ cycle, onSaved }: { cycle: Cycle; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const surveys = useSurveys();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    form.setFieldsValue({
      name: cycle.name,
      scopeDepartment: cycle.scopeDepartment,
      selfSurveyId: cycle.selfSurveyId,
      peerSurveyId: cycle.peerSurveyId,
      leaderSurveyId: cycle.leaderSurveyId,
      status: cycle.status,
    });
  }, [cycle]);

  async function save() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await http.put(`/admin/eval/cycles/${cycle.id}`, values);
      message.success("已保存");
      onSaved();
    } catch (e: any) {
      message.error(e.response?.data?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const surveyOptions = surveys.map((s) => ({ label: s.title, value: s.id }));
  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 520 }}>
      <Form.Item name="name" label="批次名称" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="scopeDepartment" label="参评范围（部门/组）">
        <Input placeholder="需与联系人部门字段一致" />
      </Form.Item>
      <Form.Item name="selfSurveyId" label="自评问卷模板">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          options={surveyOptions}
        />
      </Form.Item>
      <Form.Item name="peerSurveyId" label="他评问卷模板">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          options={surveyOptions}
        />
      </Form.Item>
      <Form.Item name="leaderSurveyId" label="领导评价问卷模板（可选）">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          options={surveyOptions}
        />
      </Form.Item>
      <Form.Item name="status" label="批次状态">
        <Select
          options={[
            { label: "草稿", value: "draft" },
            { label: "已发布", value: "published" },
            { label: "已关闭", value: "closed" },
          ]}
        />
      </Form.Item>
      <Button type="primary" loading={saving} onClick={save}>
        保存配置
      </Button>
      <Alert
        style={{ marginTop: 16 }}
        type="info"
        showIcon
        message="领导识别：在“联系人”里给领导的标签(tags)加上“领导”二字即可，生成关系时会自动跳过领导、留给人工配置。"
      />
    </Form>
  );
}

function GenerateTab({
  cycleId,
  onRelationsChanged,
}: {
  cycleId: number;
  onRelationsChanged?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<any>(null);

  async function generate() {
    setLoading(true);
    try {
      const { data } = await http.post(
        `/admin/eval/cycles/${cycleId}/generate`,
      );
      setReport(data);
      message.success("已生成");
      onRelationsChanged?.();
    } catch (e: any) {
      message.error(e.response?.data?.message || "生成失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Alert
        type="warning"
        style={{ marginBottom: 16 }}
        message="重新生成只覆盖“自动生成(auto)”的关系，人工配置(manual)的不会被冲掉。"
      />
      <Button type="primary" loading={loading} onClick={generate}>
        一键生成普通员工评价关系
      </Button>
      {report && (
        <Card size="small" style={{ marginTop: 16 }} title="生成报告">
          <Space size="large" wrap>
            <Statistic title="参评总人数" value={report.memberTotal} />
            <Statistic title="普通员工" value={report.normalCount} />
            <Statistic title="特殊人员" value={report.specialCount || 0} />
            <Statistic
              title="覆盖小组"
              value={report.coveredGroupCount || report.groups?.length || 0}
            />
            <Statistic title="生成关系总数" value={report.generated} />
            <Statistic title="自评" value={report.selfCount} />
            <Statistic title="他评" value={report.peerCount} />
          </Space>
          {report.groups?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <Typography.Text strong>小组覆盖</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Space size={[6, 8]} wrap>
                  {report.groups.map((group: any) => (
                    <Tooltip title={group.groupPath} key={group.departmentId}>
                      <Tag color={group.warning ? "orange" : "blue"}>
                        {group.groupName} · {group.normalCount} 人
                      </Tag>
                    </Tooltip>
                  ))}
                </Space>
              </div>
            </div>
          )}
          {report.warnings?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {report.warnings.map((w: string, i: number) => (
                <Alert
                  key={i}
                  type="error"
                  style={{ marginBottom: 8 }}
                  message={w}
                />
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function ReviewTab({
  cycleId,
  refreshKey = 0,
}: {
  cycleId: number;
  refreshKey?: number;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [onlyAnomaly, setOnlyAnomaly] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await http.get(`/admin/eval/cycles/${cycleId}/review`);
      setData(res.data);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [cycleId, refreshKey]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    return onlyAnomaly ? all.filter((r: any) => r.status === "异常") : all;
  }, [data, onlyAnomaly]);

  const s = data?.summary;
  return (
    <div>
      <Space size="large" style={{ marginBottom: 16 }} wrap>
        <Statistic title="参评总数" value={s?.total ?? 0} />
        <Statistic
          title="已完整"
          value={s?.complete ?? 0}
          valueStyle={{ color: "#3f8600" }}
        />
        <Statistic
          title="异常"
          value={s?.anomaly ?? 0}
          valueStyle={{ color: "#cf1322" }}
        />
        <Button onClick={load}>刷新</Button>
        <span>
          仅看异常 <Switch checked={onlyAnomaly} onChange={setOnlyAnomaly} />
        </span>
      </Space>
      {s && (
        <div style={{ marginBottom: 12 }}>
          <Space wrap>
            {Object.entries(s.byType).map(
              ([k, v]: any) =>
                v > 0 && (
                  <Tag key={k} color="red">
                    {k}: {v}
                  </Tag>
                ),
            )}
          </Space>
        </div>
      )}
      <Table
        rowKey="contactId"
        loading={loading}
        dataSource={rows}
        pagination={false}
        rowClassName={(r: any) =>
          r.status === "异常" ? "eval-row-anomaly" : ""
        }
        columns={[
          { title: "姓名", dataIndex: "name" },
          { title: "部门", dataIndex: "department", render: (v) => v || "—" },
          {
            title: "当期互评小组",
            render: (_value, row) => (
              <CompactGroupTags
                groups={(row.groups || []).map(
                  (group: ParticipantGroupSnapshotLite) => ({
                    id: group.departmentId,
                    path: group.departmentPathSnapshot,
                    primary: group.isPrimarySnapshot,
                    enabled: group.evalEnabled,
                  }),
                )}
                fallback={row.groupName}
              />
            ),
          },
          {
            title: "类型",
            dataIndex: "mode",
            width: 90,
            render: (mode: string) =>
              mode === "special" ? (
                <Tag color="gold">特殊</Tag>
              ) : (
                <Tag color="blue">普通</Tag>
              ),
          },
          {
            title: "自评",
            dataIndex: "hasSelf",
            width: 90,
            render: (v: boolean, r: any) =>
              v ? (
                r.selfSubmitted ? (
                  <Tag color="green">已填</Tag>
                ) : (
                  <Tag>待填</Tag>
                )
              ) : (
                <Tag color="red">未配</Tag>
              ),
          },
          {
            title: "被几人评",
            dataIndex: "ratedByCount",
            width: 100,
            render: (v: number, r: any) => `${r.ratedBySubmitted}/${v}`,
          },
          {
            title: "评几人",
            dataIndex: "ratingCount",
            width: 100,
            render: (v: number, r: any) => `${r.ratingSubmitted}/${v}`,
          },
          {
            title: "来源",
            dataIndex: "source",
            width: 90,
            render: (v: string) =>
              ({ auto: "自动", manual: "人工", mixed: "混合", none: "未覆盖" })[
                v
              ] || v,
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 160,
            render: (st: string, r: any) =>
              st === "完整" ? (
                <Tag color="green">完整</Tag>
              ) : (
                <Space size={4} wrap>
                  {r.anomalies.map((a: string) => (
                    <Tag color="red" key={a}>
                      {a}
                    </Tag>
                  ))}
                </Space>
              ),
          },
        ]}
      />
    </div>
  );
}

function RelationsTab({
  cycleId,
  refreshKey = 0,
  onRelationsChanged,
}: {
  cycleId: Cycle;
  refreshKey?: number;
  onRelationsChanged?: () => void;
}) {
  const cid = cycleId.id;
  const isV2 = (cycleId.version || 1) >= 2;
  const { message } = AntApp.useApp();
  const surveys = useSurveys();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [raterFilter, setRaterFilter] = useState<number>();
  const [rateeFilter, setRateeFilter] = useState<number>();
  const [relationPage, setRelationPage] = useState(1);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const relType = Form.useWatch("relationType", form);
  const relationRequestId = useRef(0);
  const loadedRelationKey = useRef("");

  async function load() {
    const requestId = relationRequestId.current + 1;
    relationRequestId.current = requestId;
    setLoading(true);
    try {
      const { data } = await http.get(`/admin/eval/cycles/${cid}/relations`, {
        timeout: 10000,
      });
      if (requestId === relationRequestId.current) setRows(data || []);
    } catch {
      if (requestId === relationRequestId.current) {
        message.error("关系明细加载失败，请重试");
      }
    } finally {
      if (requestId === relationRequestId.current) setLoading(false);
    }
  }
  useEffect(() => {
    const loadKey = `${cid}:${refreshKey}`;
    if (loadedRelationKey.current === loadKey) return;
    loadedRelationKey.current = loadKey;
    load();
  }, [cid, refreshKey]);
  useEffect(() => {
    const request =
      cycleId.version && cycleId.version >= 2
        ? http.get(`/admin/eval/cycles/${cid}/participants`).then((response) =>
            response.data.map((item: any) => ({
              id: item.contactId,
              name: item.nameSnapshot,
              department: item.groupName,
              position: item.positionSnapshot,
            })),
          )
        : http.get("/admin/contacts").then((response) => response.data || []);
    request.then(setContacts).catch(() => {});
  }, [cid, cycleId.version]);

  const raterFilterOptions = useMemo(() => {
    const people = new Map<number, { label: string; value: number }>();
    for (const row of rows) {
      if (people.has(row.raterContactId)) continue;
      people.set(row.raterContactId, {
        value: row.raterContactId,
        label: `${row.raterName}${row.raterDepartment ? `（${row.raterDepartment}）` : ""}`,
      });
    }
    return Array.from(people.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    );
  }, [rows]);
  const rateeFilterOptions = useMemo(() => {
    const people = new Map<number, { label: string; value: number }>();
    for (const row of rows) {
      if (people.has(row.rateeContactId)) continue;
      people.set(row.rateeContactId, {
        value: row.rateeContactId,
        label: `${row.rateeName}${row.rateeDepartment ? `（${row.rateeDepartment}）` : ""}`,
      });
    }
    return Array.from(people.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    );
  }, [rows]);
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (raterFilter === undefined ||
            row.raterContactId === raterFilter) &&
          (rateeFilter === undefined || row.rateeContactId === rateeFilter),
      ),
    [rows, raterFilter, rateeFilter],
  );

  useEffect(() => {
    if (
      raterFilter !== undefined &&
      !rows.some((row) => row.raterContactId === raterFilter)
    )
      setRaterFilter(undefined);
    if (
      rateeFilter !== undefined &&
      !rows.some((row) => row.rateeContactId === rateeFilter)
    )
      setRateeFilter(undefined);
  }, [rows, raterFilter, rateeFilter]);

  async function addRelation() {
    const values = await form.validateFields();
    if (values.relationType === "self")
      values.rateeContactId = values.raterContactId;
    setSaving(true);
    try {
      await http.post(`/admin/eval/cycles/${cid}/relations`, values);
      message.success("已添加");
      setModalOpen(false);
      form.resetFields();
      if (onRelationsChanged) onRelationsChanged();
      else load();
    } catch (e: any) {
      message.error(e.response?.data?.message || "添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function del(rid: number) {
    try {
      await http.delete(`/admin/eval/relations/${rid}`);
      message.success("已删除");
      if (onRelationsChanged) onRelationsChanged();
      else load();
    } catch (e: any) {
      message.error(e.response?.data?.message || "删除失败");
    }
  }

  const contactOptions = contacts.map((c) => ({
    label: `${c.name}${c.department ? `（${c.department}）` : ""}`,
    value: c.id,
  }));
  const surveyOptions = surveys.map((s) => ({ label: s.title, value: s.id }));

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Space wrap>
          <Button type="primary" onClick={() => setModalOpen(true)}>
            {isV2
              ? "人工添加关系（异常补配）"
              : "人工添加关系（领导/异常补配）"}
          </Button>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="按评价人筛选"
            style={{ width: 240 }}
            value={raterFilter}
            options={raterFilterOptions}
            onChange={(value) => {
              setRaterFilter(value);
              setRelationPage(1);
            }}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="按被评人筛选"
            style={{ width: 240 }}
            value={rateeFilter}
            options={rateeFilterOptions}
            onChange={(value) => {
              setRateeFilter(value);
              setRelationPage(1);
            }}
          />
          <Button
            disabled={raterFilter === undefined && rateeFilter === undefined}
            onClick={() => {
              setRaterFilter(undefined);
              setRateeFilter(undefined);
              setRelationPage(1);
            }}
          >
            清空筛选
          </Button>
          <Typography.Text type="secondary">
            筛选结果 {filteredRows.length} 条 / 共 {rows.length} 条
          </Typography.Text>
        </Space>
        <Button loading={loading} onClick={() => load()}>
          刷新明细
        </Button>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filteredRows}
        size="small"
        locale={{ emptyText: "暂无评价关系，请先生成或人工添加" }}
        pagination={{
          current: relationPage,
          pageSize: 20,
          onChange: setRelationPage,
          showTotal: (total) => `共 ${total} 条`,
        }}
        columns={[
          { title: "评价人", dataIndex: "raterName" },
          { title: "被评人", dataIndex: "rateeName" },
          {
            title: "类型",
            dataIndex: "relationType",
            width: 100,
            render: (v: string) => (
              <Tag
                color={v === "self" ? "blue" : v === "peer" ? "cyan" : "gold"}
              >
                {TYPE_LABEL[v] || v}
              </Tag>
            ),
          },
          {
            title: "来源",
            dataIndex: "source",
            width: 260,
            render: (v: string, row: any) =>
              v === "manual" ? (
                <Tag color="purple">人工</Tag>
              ) : row.relationType === "self" ? (
                <Tag color="green">自动·自评</Tag>
              ) : row.sharedGroups?.length ? (
                <Space size={[4, 4]} wrap>
                  {row.sharedGroups.map(
                    (group: {
                      departmentId: number | null;
                      name: string;
                      path: string;
                    }) => (
                      <Tooltip
                        title={group.path}
                        key={`${group.departmentId}:${group.path}`}
                      >
                        <Tag color="blue">自动·{group.name}</Tag>
                      </Tooltip>
                    ),
                  )}
                </Space>
              ) : (
                <Tag>自动</Tag>
              ),
          },
          {
            title: "已填",
            dataIndex: "done",
            width: 80,
            render: (v: boolean) =>
              v ? <Tag color="green">已填</Tag> : <Tag>待填</Tag>,
          },
          {
            title: "操作",
            width: 90,
            render: (_: any, r: any) => (
              <Popconfirm title="删除该关系？" onConfirm={() => del(r.id)}>
                <Button type="link" danger size="small" disabled={r.done}>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      <Modal
        title="人工添加评价关系"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={addRelation}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{ relationType: isV2 ? "peer" : "leader" }}
        >
          <Form.Item
            name="relationType"
            label="关系类型"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { label: "自评", value: "self" },
                { label: "他评", value: "peer" },
                ...(!isV2 ? [{ label: "领导评价", value: "leader" }] : []),
              ]}
            />
          </Form.Item>
          <Form.Item
            name="raterContactId"
            label="评价人"
            rules={[{ required: true, message: "请选择评价人" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={contactOptions}
              placeholder="谁来评"
            />
          </Form.Item>
          {relType !== "self" && (
            <Form.Item
              name="rateeContactId"
              label="被评人"
              rules={[{ required: true, message: "请选择被评人" }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={contactOptions}
                placeholder="评价谁"
              />
            </Form.Item>
          )}
          {(!cycleId.version || cycleId.version < 2) && (
            <Form.Item name="surveyId" label="问卷模板（留空则用批次默认模板）">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={surveyOptions}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}

// ============ 填写端（员工）============
interface ArchivedResultListItem {
  cycleId: number;
  cycleName: string;
  archivedAt: string;
  resultAvailable: boolean;
  totalScore: number | null;
  receivedCount: number;
  expectedCount: number;
}

interface ArchivedPersonalResult {
  cycle: {
    id: number;
    name: string;
    status: "archived";
    archivedAt: string;
  };
  participant: {
    contactId: number;
    name: string;
  };
  result: {
    totalScore: number | null;
    receivedCount: number;
    expectedCount: number;
    dimensionScores: Array<{
      dimensionId: string;
      name: string;
      score: number | null;
    }>;
    questionScores: Array<{
      questionId: string;
      label: string;
      selfScore: number | null;
      otherScore: number | null;
      score: number | null;
      answerCount: number;
    }>;
  };
}

function evalTypeColor(type: string) {
  if (type === "self") return "blue";
  if (type === "leader") return "gold";
  return "cyan";
}

function evalDeadlineText(endAt: string | null) {
  const state = getEvalDeadlineState(endAt);
  if (state === "none") return { state, text: "长期有效" };
  if (state === "expired") return { state, text: "已截止" };
  if (state === "urgent") {
    const hours = Math.max(1, dayjs(endAt).diff(dayjs(), "hour"));
    return {
      state,
      text: hours < 24 ? `剩余 ${hours} 小时` : `剩余 ${Math.ceil(hours / 24)} 天`,
    };
  }
  return { state, text: `截止 ${dayjs(endAt).format("MM月DD日 HH:mm")}` };
}

function EvalPendingTaskCard({
  task,
  onOpen,
}: {
  task: EvalFillTaskItem;
  onOpen: (relationId: number) => void;
}) {
  const deadline = evalDeadlineText(task.cycleEndAt);
  return (
    <Card
      size="small"
      className={`eval-fill-task-card ${deadline.state === "urgent" ? "is-urgent" : ""}`}
    >
      <div className="eval-fill-task-card-head">
        <div className="eval-fill-task-card-tags">
          <Tag color={evalTypeColor(task.type)}>
            {TYPE_LABEL[task.type] || task.type}
          </Tag>
          {deadline.state === "urgent" && <Tag color="orange">即将截止</Tag>}
        </div>
        <span className={`eval-fill-deadline is-${deadline.state}`}>
          <ClockCircleOutlined /> {deadline.text}
        </span>
      </div>
      <Typography.Title level={5} className="eval-fill-task-name">
        评价对象：{task.rateeName}
      </Typography.Title>
      <Typography.Text type="secondary" className="eval-fill-task-survey">
        {task.cycleName} · {task.surveyTitle}
      </Typography.Text>
      <Button
        type="primary"
        size="large"
        className="eval-fill-task-action"
        onClick={() => onOpen(task.relationId)}
      >
        开始填写
      </Button>
    </Card>
  );
}

function EvalArchivedResultCard({
  item,
  onOpen,
}: {
  item: ArchivedResultListItem;
  onOpen: (cycleId: number) => void;
}) {
  const completion = item.expectedCount
    ? Math.min(100, Math.round((item.receivedCount / item.expectedCount) * 100))
    : 0;
  return (
    <Card size="small" className="eval-fill-result-card">
      <div className="eval-fill-result-card-head">
        <div>
          <Tag color="green" icon={<CheckCircleFilled />}>
            已归档
          </Tag>
          <Typography.Title level={5}>{item.cycleName}</Typography.Title>
        </div>
        <div className="eval-fill-result-score">
          <strong>
            {item.totalScore === null ? "—" : Number(item.totalScore).toFixed(2)}
          </strong>
          <span>最终总分</span>
        </div>
      </div>
      <div className="eval-fill-result-meta">
        <span>
          归档于 {item.archivedAt ? dayjs(item.archivedAt).format("YYYY-MM-DD") : "—"}
        </span>
        <span>
          评分收集 {item.receivedCount}/{item.expectedCount}
        </span>
      </div>
      <Progress
        percent={completion}
        showInfo={false}
        size="small"
        strokeColor="#1677ff"
      />
      <Button
        block
        size="large"
        disabled={!item.resultAvailable}
        onClick={() => onOpen(item.cycleId)}
      >
        {item.resultAvailable ? "查看个人结果" : "暂无可查看结果"}
      </Button>
    </Card>
  );
}

export function EvalFillPage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [token, setToken] = useState(localStorage.getItem("fill_token") || "");
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [picked, setPicked] = useState<number | undefined>();
  const [devEnabled, setDevEnabled] = useState(true);
  const [groups, setGroups] = useState<EvalFillTaskGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [tasksError, setTasksError] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"tasks" | "results">(() =>
    new URLSearchParams(location.search).get("tab") === "results"
      ? "results"
      : "tasks",
  );
  const [archivedResults, setArchivedResults] = useState<
    ArchivedResultListItem[]
  >([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [archivedError, setArchivedError] = useState("");
  const taskView = useMemo(() => buildEvalFillTaskView(groups), [groups]);
  const displayName = useMemo(() => getEvalFillDisplayName(token), [token]);

  // 企业微信登录回调：URL 里带 fill_token 就存下来并清理地址栏
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get("fill_token");
    if (t) {
      localStorage.setItem("fill_token", t);
      setToken(t);
      window.history.replaceState({}, "", "/eval-fill");
    }
  }, []);

  useEffect(() => {
    if (!token) {
      fillHttp
        .get("/eval-dev/contacts")
        .then((r) => setContacts(r.data || []))
        .catch(() => setDevEnabled(false));
    }
  }, [token]);

  function wecomLogin() {
    window.location.href = `/api/wecom/oauth/url?state=${encodeURIComponent("/eval-fill")}`;
  }

  async function loadTasks() {
    setLoading(true);
    setTasksError("");
    try {
      const { data } = await fillHttp.get("/eval/tasks");
      setGroups(data || []);
    } catch (e: any) {
      if (e.response?.status === 401) {
        localStorage.removeItem("fill_token");
        setToken("");
        return;
      }
      setTasksError(e.response?.data?.message || "填写任务加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (token) loadTasks();
  }, [token]);

  async function loadArchivedResults() {
    setArchivedLoading(true);
    setArchivedError("");
    try {
      const { data } = await fillHttp.get("/eval/archived-results");
      setArchivedResults(data || []);
      setArchivedLoaded(true);
    } catch (e: any) {
      if (e.response?.status === 401) {
        localStorage.removeItem("fill_token");
        setToken("");
        return;
      }
      setArchivedError(
        e.response?.data?.message || "个人环评结果加载失败，请稍后重试",
      );
    } finally {
      setArchivedLoading(false);
    }
  }

  useEffect(() => {
    if (token && activeTab === "results" && !archivedLoaded) {
      loadArchivedResults();
    }
  }, [token, activeTab, archivedLoaded]);

  async function devLogin() {
    if (!picked) {
      message.warning("请选择一个员工身份");
      return;
    }
    try {
      const { data } = await fillHttp.post("/eval-dev/login", {
        contactId: picked,
      });
      localStorage.setItem("fill_token", data.token);
      setToken(data.token);
      message.success(`已以「${data.name}」身份登录`);
    } catch (e: any) {
      message.error(e.response?.data?.message || "登录失败");
    }
  }
  function logout() {
    localStorage.removeItem("fill_token");
    setToken("");
    setGroups([]);
    setTasksError("");
    setArchivedResults([]);
    setArchivedLoaded(false);
  }

  if (active !== null) {
    return (
      <FillTaskView
        relationId={active}
        onDone={() => {
          setActive(null);
          loadTasks();
        }}
        onBack={() => setActive(null)}
      />
    );
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 440, margin: "80px auto" }}>
        <Card title="360 环评 · 登录填写">
          <Button type="primary" block size="large" onClick={wecomLogin}>
            企业微信登录
          </Button>
          {devEnabled && (
            <>
              <Divider>本地测试（不走企微）</Divider>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="本地没有企业微信，用下面的下拉选一个员工身份进入。服务器上请用上方“企业微信登录”。"
              />
              <Select
                style={{ width: "100%" }}
                showSearch
                optionFilterProp="label"
                placeholder="选择你要假装的员工"
                value={picked}
                onChange={setPicked}
                options={contacts.map((c) => ({
                  label: `${c.name}${c.department ? `（${c.department}）` : ""}`,
                  value: c.id,
                }))}
              />
              <Button block style={{ marginTop: 16 }} onClick={devLogin}>
                进入填写（测试身份）
              </Button>
            </>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="eval-fill-list-page">
      <header className="eval-fill-list-header">
        <div className="eval-fill-brand">
          <Avatar shape="square" size={40} icon={<FileDoneOutlined />} />
          <div>
            <Typography.Title level={4}>360 环评</Typography.Title>
            <Typography.Text type="secondary">我的评价任务中心</Typography.Text>
          </div>
        </div>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              {
                key: "switch",
                icon: <UserOutlined />,
                label: "切换身份",
                onClick: logout,
              },
            ],
          }}
        >
          <Button className="eval-fill-user-button">
            <Avatar size={24} icon={<UserOutlined />} />
            <span>{displayName}</span>
            <DownOutlined />
          </Button>
        </Dropdown>
      </header>

      <Tabs
        className="eval-fill-list-tabs"
        activeKey={activeTab}
        onChange={(key) => {
          const next = key === "results" ? "results" : "tasks";
          setActiveTab(next);
          navigate(
            next === "results" ? "/eval-fill?tab=results" : "/eval-fill",
            { replace: true },
          );
        }}
        items={[
          {
            key: "tasks",
            label: (
              <span className="eval-fill-tab-label">
                待我填写
                {!!taskView.pending.length && (
                  <Badge count={taskView.pending.length} size="small" />
                )}
              </span>
            ),
            children: loading ? (
              <div className="eval-fill-card-list">
                {[1, 2].map((item) => (
                  <Card key={item} className="eval-fill-task-card">
                    <Skeleton active paragraph={{ rows: 3 }} />
                  </Card>
                ))}
              </div>
            ) : tasksError ? (
              <Result
                status="warning"
                title="填写任务加载失败"
                subTitle={tasksError}
                extra={
                  <Button type="primary" onClick={loadTasks}>
                    重新加载
                  </Button>
                }
              />
            ) : taskView.total === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前没有分配给你的评价任务"
              />
            ) : (
              <div className="eval-fill-tasks-panel">
                <section className="eval-fill-task-overview">
                  <div className="eval-fill-overview-copy">
                    <span>本轮待办</span>
                    <strong>{taskView.pending.length} 份问卷</strong>
                    <small>
                      已完成 {taskView.completedCount}/{taskView.total}
                      {taskView.nearestEndAt
                        ? ` · 最近截止 ${dayjs(taskView.nearestEndAt).format("MM月DD日 HH:mm")}`
                        : ""}
                    </small>
                  </div>
                  <Progress
                    type="circle"
                    size={68}
                    percent={taskView.progressPercent}
                    strokeColor="#1677ff"
                  />
                </section>

                {taskView.pending.length ? (
                  <div className="eval-fill-card-list">
                    {taskView.pending.map((task) => (
                      <EvalPendingTaskCard
                        key={task.relationId}
                        task={task}
                        onOpen={setActive}
                      />
                    ))}
                  </div>
                ) : (
                  <Result
                    status="success"
                    title="本轮任务已全部完成"
                    subTitle="感谢你的认真填写"
                  />
                )}

                {!!taskView.completed.length && (
                  <Collapse
                    ghost
                    className="eval-fill-completed-collapse"
                    items={[
                      {
                        key: "completed",
                        label: `已完成 ${taskView.completed.length} 份`,
                        children: (
                          <div className="eval-fill-completed-list">
                            {taskView.completed.map((task) => (
                              <div key={task.relationId}>
                                <CheckCircleFilled />
                                <span>
                                  {task.rateeName} · {task.surveyTitle}
                                </span>
                                <Tag color="success">已完成</Tag>
                              </div>
                            ))}
                          </div>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            ),
          },
          {
            key: "results",
            label: (
              <span className="eval-fill-tab-label">
                我的结果
                {archivedLoaded && archivedResults.length > 0 && (
                  <Badge
                    count={archivedResults.length}
                    size="small"
                    color="#8c8c8c"
                  />
                )}
              </span>
            ),
            children: (
              <div className="eval-fill-results-panel">
                <Alert
                  type="info"
                  showIcon
                  icon={<SafetyCertificateOutlined />}
                  message="个人结果仅展示你的汇总评分"
                  description="不展示其他评价人的身份和文字反馈"
                />
                {archivedLoading ? (
                  <div className="eval-fill-card-list">
                    {[1, 2].map((item) => (
                      <Card key={item} className="eval-fill-result-card">
                        <Skeleton active paragraph={{ rows: 3 }} />
                      </Card>
                    ))}
                  </div>
                ) : archivedError ? (
                  <Result
                    status="warning"
                    title="个人环评结果加载失败"
                    subTitle={archivedError}
                    extra={
                      <Button type="primary" onClick={loadArchivedResults}>
                        重新加载
                      </Button>
                    }
                  />
                ) : archivedResults.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无已归档的个人环评结果"
                  />
                ) : (
                  <div className="eval-fill-card-list">
                    {archivedResults.map((item) => (
                      <EvalArchivedResultCard
                        key={item.cycleId}
                        item={item}
                        onOpen={(cycleId) =>
                          navigate(`/eval-fill/results/${cycleId}`)
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

export function EvalPersonalResultPage() {
  const { cycleId } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<ArchivedPersonalResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!localStorage.getItem("fill_token")) {
      navigate("/eval-fill", { replace: true });
      return;
    }
    setLoading(true);
    setError("");
    fillHttp
      .get(`/eval/archived-results/${cycleId}`)
      .then(({ data }) => setReport(data))
      .catch((e: any) => {
        if (e.response?.status === 401) {
          localStorage.removeItem("fill_token");
          navigate("/eval-fill", { replace: true });
          return;
        }
        setError(
          e.response?.data?.message || "个人环评结果不存在或暂不可查看",
        );
      })
      .finally(() => setLoading(false));
  }, [cycleId, navigate]);

  if (loading) {
    return (
      <div className="eval-personal-result-page is-loading">
        <Spin />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="eval-personal-result-page">
        <Result
          status="warning"
          title={error || "个人环评结果不存在或暂不可查看"}
          extra={
            <Button onClick={() => navigate("/eval-fill?tab=results")}>
              返回我的结果
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="eval-personal-result-page">
      <div className="eval-personal-result-header">
        <Button type="link" onClick={() => navigate("/eval-fill?tab=results")}>
          ← 返回我的结果
        </Button>
        <Tag>已归档</Tag>
      </div>
      <Typography.Title level={3}>{report.cycle.name}</Typography.Title>
      <Typography.Text type="secondary">
        {report.participant.name} · 归档时间{" "}
        {dayjs(report.cycle.archivedAt).format("YYYY-MM-DD HH:mm")}
      </Typography.Text>

      <Row gutter={[16, 16]} className="eval-personal-result-summary">
        <Col xs={24} sm={12}>
          <Card>
            <Statistic
              title="最终总分"
              value={
                report.result.totalScore === null
                  ? "—"
                  : Number(report.result.totalScore).toFixed(2)
              }
            />
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card>
            <Statistic
              title="已收/应收"
              value={`${report.result.receivedCount}/${report.result.expectedCount}`}
            />
          </Card>
        </Col>
      </Row>

      <Alert
        type="info"
        showIcon
        className="eval-personal-result-privacy"
        message="结果仅展示汇总评分，不展示评价人身份及文字反馈"
      />

      <Typography.Title level={5}>维度得分</Typography.Title>
      <Table
        size="small"
        pagination={false}
        rowKey="dimensionId"
        dataSource={report.result.dimensionScores}
        columns={[
          { title: "维度", dataIndex: "name" },
          { title: "得分", dataIndex: "score", render: scoreText },
        ]}
      />

      <Typography.Title level={5} className="eval-personal-result-section">
        逐题得分
      </Typography.Title>
      <Table
        size="small"
        pagination={false}
        rowKey="questionId"
        dataSource={report.result.questionScores}
        scroll={{ x: 720 }}
        columns={[
          { title: "题目", dataIndex: "label", width: 220 },
          { title: "自评", dataIndex: "selfScore", render: scoreText },
          { title: "他评平均", dataIndex: "otherScore", render: scoreText },
          { title: "综合", dataIndex: "score", render: scoreText },
          { title: "有效答案", dataIndex: "answerCount" },
        ]}
      />
    </div>
  );
}

function FillTaskView({
  relationId,
  onDone,
  onBack,
}: {
  relationId: number;
  onDone: () => void;
  onBack: () => void;
}) {
  const { message } = AntApp.useApp();
  const [task, setTask] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [submitting, setSubmitting] = useState(false);
  const [startedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    fillHttp
      .get(`/eval/tasks/${relationId}`)
      .then((r) => setTask(r.data))
      .catch(() => {});
  }, [relationId]);

  if (!task)
    return (
      <div style={{ maxWidth: 720, margin: "80px auto", textAlign: "center" }}>
        <Spin />
      </div>
    );
  if (task.done) {
    return (
      <div style={{ maxWidth: 720, margin: "40px auto" }}>
        <Result
          status="success"
          title="这份你已经填过了"
          extra={<Button onClick={onBack}>返回列表</Button>}
        />
      </div>
    );
  }
  const questions: any[] = task.survey?.schemaJson?.questions || [];
  const instructions = String(
    task.survey?.schemaJson?.instructions || "",
  ).trim();
  const dimensions: Array<{ id: string; name: string }> =
    task.survey?.schemaJson?.dimensions || [];
  const dimensionNames = new Map<string, string>(
    dimensions.map((dimension) => [dimension.id, dimension.name]),
  );

  async function submit() {
    for (const q of questions) {
      if (q.type === "evaluation_score") {
        const answer = answers[q.id];
        if (
          q.required &&
          (!answer || answer.score === undefined || answer.score === null)
        ) {
          message.warning(`请评分：${q.label}`);
          return;
        }
        if (
          answer &&
          q.caseRequiredScores?.includes(Number(answer.score)) &&
          !String(answer.caseText || "").trim()
        ) {
          message.warning(`请填写“${q.label}”的案例说明`);
          return;
        }
        continue;
      }
      if (q.type === "evaluation_text") {
        const text =
          typeof answers[q.id] === "string" ? answers[q.id].trim() : "";
        if (q.required && !text) {
          message.warning(`请填写：${q.label}`);
          return;
        }
        if (text.length > (q.maxLength || 2000)) {
          message.warning(`“${q.label}”最多填写 ${q.maxLength || 2000} 个字符`);
          return;
        }
        continue;
      }
      if (q.required && q.type !== "description") {
        const v = answers[q.id];
        if (
          v === undefined ||
          v === "" ||
          (Array.isArray(v) && v.length === 0)
        ) {
          message.warning(`请填写：${q.label}`);
          return;
        }
      }
    }
    setSubmitting(true);
    try {
      await fillHttp.post(`/eval/tasks/${relationId}/submit`, {
        answers,
        startedAt,
      });
      message.success("提交成功");
      onDone();
    } catch (e: any) {
      message.error(e.response?.data?.message || "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "24px auto" }}>
      <Card
        title={
          <Space>
            <Button type="link" onClick={onBack}>
              ← 返回
            </Button>
            {task.type === "self" ? "自评" : `评价 ${task.rateeName}`} ·{" "}
            {task.survey.title}
          </Space>
        }
      >
        {instructions && (
          <div className="eval-fill-instructions">
            <div className="eval-fill-instructions-title">填写说明</div>
            <div className="eval-fill-instructions-content">
              {instructions}
            </div>
          </div>
        )}
        {questions.length === 0 && <Empty description="这份问卷还没有题目" />}
        {questions.map((q, questionIndex) => (
          <div
            key={q.id}
            className={`eval-fill-question-block ${q.type === "evaluation_score" ? "eval-fill-score-question-block" : ""}`}
          >
            {q.type !== "description" ? (
              <>
                {q.type === "evaluation_score" && (
                  <div className="eval-score-fill-meta">
                    <span>
                      第 {questionIndex + 1} 题 / 共 {questions.length} 题
                    </span>
                    {dimensionNames.get(q.dimensionId) && (
                      <Tag color="blue">
                        {dimensionNames.get(q.dimensionId)}
                      </Tag>
                    )}
                  </div>
                )}
                <div className="eval-fill-question-title">
                  {q.required && (
                    <span className="eval-fill-required-mark">*</span>
                  )}
                  {q.label}
                </div>
              </>
            ) : (
              <div style={{ marginBottom: 8, color: "#555" }}>{q.label}</div>
            )}
            {q.description && (
              <div className="eval-fill-question-description">
                {q.description}
              </div>
            )}
            {q.type === "evaluation_score" ? (
              <EvalQuestionField
                q={q}
                value={answers[q.id]}
                onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
              />
            ) : q.type === "evaluation_text" ? (
              <Input.TextArea
                rows={5}
                showCount
                maxLength={q.maxLength || 2000}
                value={answers[q.id] || ""}
                placeholder={
                  q.required
                    ? "请输入文字反馈（必填）"
                    : "请输入文字反馈（选填）"
                }
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [q.id]: event.target.value,
                  }))
                }
              />
            ) : (
              <QuestionField
                q={q}
                value={answers[q.id]}
                onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
              />
            )}
          </div>
        ))}
        <Divider />
        <Button type="primary" loading={submitting} onClick={submit}>
          提交
        </Button>
      </Card>
    </div>
  );
}

function EvalQuestionField({
  q,
  value,
  onChange,
}: {
  q: EvalScoreQuestion;
  value: any;
  onChange: (value: any) => void;
}) {
  const selectedScore = value?.score;
  const caseRequired = q.caseRequiredScores?.includes(Number(selectedScore));
  return (
    <div className="eval-fill-question">
      <Radio.Group
        aria-label={`${q.label}评分`}
        className="eval-score-fill-options"
        value={selectedScore}
        onChange={(event) =>
          onChange({
            score: event.target.value,
            caseText: value?.caseText || "",
          })
        }
      >
        {(q.options || []).map((option) => (
          <Radio
            key={option.score}
            value={option.score}
            className="eval-score-fill-option"
          >
            <span className="eval-score-fill-option-content">
              <span className="eval-score-fill-badge">{option.score} 分</span>
              <span className="eval-score-fill-behavior">{option.label}</span>
            </span>
          </Radio>
        ))}
      </Radio.Group>
      {caseRequired && (
        <div className="eval-score-fill-case-panel">
          <div className="eval-score-fill-case-heading">
            <Typography.Text strong>请填写具体案例</Typography.Text>
            <Tag color="orange">当前分值必填</Tag>
          </div>
          <Input.TextArea
            aria-label="具体案例"
            rows={3}
            showCount
            value={value?.caseText || ""}
            placeholder={
              q.casePrompt ||
              "请描述具体场景、员工行为及产生的影响，让评价更有依据"
            }
            status={
              !String(value?.caseText || "").trim() ? "warning" : undefined
            }
            onChange={(event) =>
              onChange({ score: selectedScore, caseText: event.target.value })
            }
          />
          {!String(value?.caseText || "").trim() && (
            <Typography.Text
              type="warning"
              className="eval-score-fill-case-warning"
            >
              当前分值需要填写具体案例
            </Typography.Text>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionField({
  q,
  value,
  onChange,
}: {
  q: any;
  value: any;
  onChange: (v: any) => void;
}) {
  switch (q.type) {
    case "description":
      return null;
    case "radio":
      return (
        <Radio.Group value={value} onChange={(e) => onChange(e.target.value)}>
          <Space direction="vertical">
            {(q.options || []).map((o: string) => (
              <Radio key={o} value={o}>
                {o}
              </Radio>
            ))}
          </Space>
        </Radio.Group>
      );
    case "checkbox":
      return (
        <Checkbox.Group
          value={value || []}
          onChange={onChange}
          options={(q.options || []).map((o: string) => ({
            label: o,
            value: o,
          }))}
        />
      );
    case "rating":
      return <Rate count={q.maxScore || 5} value={value} onChange={onChange} />;
    case "textarea":
      return (
        <Input.TextArea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return (
        <DatePicker
          value={value ? dayjs(value) : null}
          onChange={(_, ds) => onChange(ds)}
        />
      );
    case "datetime":
      return (
        <DatePicker
          showTime
          value={value ? dayjs(value) : null}
          onChange={(_, ds) => onChange(ds)}
        />
      );
    case "text":
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}
