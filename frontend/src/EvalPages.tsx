import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import dayjs from "dayjs";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  QRCode,
  Radio,
  Rate,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { http, fillHttp, downloadFile } from "./App";

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
}
interface EvalTemplate {
  version: 2;
  kind: "evaluation";
  dimensions: Array<{ id: string; name: string; order: number }>;
  questions: Array<{
    id: string;
    type: "evaluation_score";
    label: string;
    description?: string;
    dimensionId: string;
    required: boolean;
    countInScore: boolean;
    options: Array<{ score: number; label: string }>;
    casePrompt?: string;
    caseRequiredScores: number[];
  }>;
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
    patch: Partial<EvalTemplate["questions"][number]>,
  ) {
    setSchema((current) => ({
      ...current,
      questions: current.questions.map((question, i) =>
        i === index ? { ...question, ...patch } : question,
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

  function addQuestion() {
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
            {schema.questions.map((question, index) => (
              <Card
                key={question.id}
                className="eval-question-editor"
                title={`题目 ${index + 1}`}
                extra={
                  !readonly && (
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
                  )
                }
              >
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
                    updateQuestion(index, { description: event.target.value })
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
                <div className="eval-score-option-grid">
                  {question.options.map((option, optionIndex) => (
                    <div className="eval-score-option-row" key={option.score}>
                      <span className="eval-score-badge">
                        {option.score} 分
                      </span>
                      <Input
                        value={option.label}
                        disabled={readonly}
                        onChange={(event) =>
                          updateQuestion(index, {
                            options: question.options.map((item, i) =>
                              i === optionIndex
                                ? { ...item, label: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
                <Input
                  style={{ marginTop: 12 }}
                  value={question.casePrompt}
                  disabled={readonly}
                  addonBefore="案例提示"
                  onChange={(event) =>
                    updateQuestion(index, { casePrompt: event.target.value })
                  }
                />
                <div style={{ marginTop: 12 }}>
                  <Typography.Text>选择后必须填写案例的分值：</Typography.Text>
                  <Checkbox.Group
                    disabled={readonly}
                    value={question.caseRequiredScores}
                    options={[0, 1, 2, 3, 4, 5].map((score) => ({
                      label: `${score} 分`,
                      value: score,
                    }))}
                    onChange={(values) =>
                      updateQuestion(index, {
                        caseRequiredScores: values as number[],
                      })
                    }
                  />
                </div>
                <Space style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={question.required}
                    disabled={readonly}
                    onChange={(event) =>
                      updateQuestion(index, { required: event.target.checked })
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
                </Space>
              </Card>
            ))}
            {!readonly && (
              <Button block type="dashed" onClick={addQuestion}>
                添加计分题
              </Button>
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

function EvalPeopleTab({ cycle }: { cycle: Cycle }) {
  return (
    <Tabs
      items={[
        {
          key: "participants",
          label: "参评人员",
          children: <EvalParticipantsTab cycle={cycle} />,
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
              <GenerateTab cycleId={cycle.id} />
              <Divider />
              <ReviewTab cycleId={cycle.id} />
              <Divider />
              <RelationsTab cycleId={cycle} />
            </div>
          ),
        },
      ]}
    />
  );
}

function EvalParticipantsTab({ cycle }: { cycle: Cycle }) {
  const { message } = AntApp.useApp();
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [departments, setDepartments] = useState<
    Array<{ name: string; count: number }>
  >([]);
  const [participants, setParticipants] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [sourceCycleId, setSourceCycleId] = useState<number>();
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const readonly = cycle.status !== "draft";

  async function load() {
    const [candidateResponse, participantResponse] = await Promise.all([
      http.get("/admin/eval/participant-candidates"),
      http.get(`/admin/eval/cycles/${cycle.id}/participants`),
    ]);
    setContacts(candidateResponse.data.contacts || []);
    setDepartments(candidateResponse.data.departments || []);
    setParticipants(participantResponse.data || []);
    setSelectedIds(
      (participantResponse.data || []).map(
        (participant: any) => participant.contactId,
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
  }, [cycle.id]);

  function selectDepartments(values: string[]) {
    setSelectedDepartments(values);
    setSelectedIds(
      contacts
        .filter((contact) =>
          values.includes(contact.department?.trim() || "未分组"),
        )
        .map((contact) => contact.id),
    );
  }

  async function save() {
    setSaving(true);
    try {
      await http.put(`/admin/eval/cycles/${cycle.id}/participants`, {
        contactIds: selectedIds,
      });
      message.success(`已生成 ${selectedIds.length} 人的批次快照`);
      load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "保存失败");
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
      load();
    } catch (error: any) {
      message.error(error.response?.data?.message || "复制失败");
    }
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="候选人直接来自联系人模块。保存后形成当前批次快照，联系人后续变更不会静默改写本批次。"
      />
      {!readonly && (
        <Card className="eval-toolbar-card">
          <Space wrap>
            <Select
              mode="multiple"
              style={{ minWidth: 360 }}
              placeholder="按部门/组选择"
              value={selectedDepartments}
              options={departments.map((department) => ({
                label: `${department.name}（${department.count} 人）`,
                value: department.name,
              }))}
              onChange={selectDepartments}
            />
            <Button onClick={() => setCopyOpen(true)}>复制上一批次</Button>
            <Button type="primary" loading={saving} onClick={save}>
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
        pagination={{ pageSize: 15 }}
        columns={[
          { title: "姓名", dataIndex: "name" },
          {
            title: "部门/组",
            dataIndex: "department",
            render: (value) => value || "未分组",
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
        ]}
      />
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
        { title: "评价小组", dataIndex: "groupName" },
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
              <Button type="link" onClick={() => openReport(row.contactId)}>
                查看报告
              </Button>
            ),
          },
        ]}
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

function EvalReportContent({ report }: { report: any }) {
  const result = report.result;
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
            <div style={{ marginTop: 8 }}>{item.caseText}</div>
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
  const fillUrl = `${location.origin}/eval-fill`;

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
            children: <GenerateTab cycleId={cycleId} />,
          },
          {
            key: "review",
            label: "③ 复核列表",
            children: <ReviewTab cycleId={cycleId} />,
          },
          {
            key: "relations",
            label: "④ 关系明细 / 人工配置",
            children: <RelationsTab cycleId={cycle} />,
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

function GenerateTab({ cycleId }: { cycleId: number }) {
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
            <Statistic title="领导（已跳过）" value={report.leaderCount} />
            <Statistic title="普通员工" value={report.normalCount} />
            <Statistic title="生成关系总数" value={report.generated} />
            <Statistic title="自评" value={report.selfCount} />
            <Statistic title="他评" value={report.peerCount} />
          </Space>
          <div style={{ marginTop: 12, color: "#888" }}>
            校验：普通员工 {report.normalCount} 人 ⇒ 应为 {report.normalCount}{" "}
            份自评 + {report.normalCount * (report.normalCount - 1)} 份他评 ={" "}
            {report.normalCount * report.normalCount} 条
          </div>
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

function ReviewTab({ cycleId }: { cycleId: number }) {
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
  }, [cycleId]);

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
            title: "角色",
            dataIndex: "isLeader",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="gold">领导</Tag> : "普通"),
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

function RelationsTab({ cycleId }: { cycleId: Cycle }) {
  const cid = cycleId.id;
  const { message } = AntApp.useApp();
  const surveys = useSurveys();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const relType = Form.useWatch("relationType", form);

  async function load() {
    setLoading(true);
    try {
      const { data } = await http.get(`/admin/eval/cycles/${cid}/relations`);
      setRows(data || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [cid]);
  useEffect(() => {
    const request =
      cycleId.version && cycleId.version >= 2
        ? http
            .get(`/admin/eval/cycles/${cid}/participants`)
            .then((response) =>
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
      load();
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
      load();
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
      <Button
        type="primary"
        style={{ marginBottom: 16 }}
        onClick={() => setModalOpen(true)}
      >
        人工添加关系（领导/异常补配）
      </Button>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        size="small"
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "评价人", dataIndex: "raterName" },
          { title: "被评人", dataIndex: "rateeName" },
          {
            title: "类型",
            dataIndex: "relationType",
            width: 100,
            render: (v: string) => TYPE_LABEL[v] || v,
          },
          {
            title: "来源",
            dataIndex: "source",
            width: 90,
            render: (v: string) =>
              v === "manual" ? <Tag color="blue">人工</Tag> : "自动",
          },
          {
            title: "已填",
            dataIndex: "done",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="green">是</Tag> : "否"),
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
          initialValues={{ relationType: "leader" }}
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
                { label: "领导评价", value: "leader" },
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
export function EvalFillPage() {
  const { message } = AntApp.useApp();
  const [token, setToken] = useState(localStorage.getItem("fill_token") || "");
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [picked, setPicked] = useState<number | undefined>();
  const [devEnabled, setDevEnabled] = useState(true);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<number | null>(null);

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
    try {
      const { data } = await fillHttp.get("/eval/tasks");
      setGroups(data || []);
    } catch (e: any) {
      if (e.response?.status === 401) {
        localStorage.removeItem("fill_token");
        setToken("");
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (token) loadTasks();
  }, [token]);

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
    <div style={{ maxWidth: 720, margin: "24px auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          待我填写
        </Typography.Title>
        <Button onClick={logout}>切换身份</Button>
      </div>
      {loading ? (
        <Spin />
      ) : groups.length === 0 ? (
        <Empty description="暂无待填写任务（确认批次已发布、且有分配给你的关系）" />
      ) : (
        groups.map((g) => (
          <Card
            key={g.cycleId}
            title={g.cycleName}
            style={{ marginBottom: 16 }}
          >
            {g.tasks.map((t: any) => (
              <div
                key={t.relationId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 0",
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <span>
                  <Tag>{TYPE_LABEL[t.type] || t.type}</Tag> {t.rateeName} ·{" "}
                  {t.surveyTitle}
                </span>
                {t.done ? (
                  <Tag color="green">已完成</Tag>
                ) : (
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => setActive(t.relationId)}
                  >
                    去填写
                  </Button>
                )}
              </div>
            ))}
          </Card>
        ))
      )}
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
        {questions.length === 0 && <Empty description="这份问卷还没有题目" />}
        {questions.map((q) => (
          <div key={q.id} style={{ marginBottom: 20 }}>
            {q.type !== "description" ? (
              <div style={{ marginBottom: 8, fontWeight: 500 }}>
                {q.label}
                {q.required && <span style={{ color: "red" }}> *</span>}
              </div>
            ) : (
              <div style={{ marginBottom: 8, color: "#555" }}>{q.label}</div>
            )}
            {q.description && (
              <div style={{ color: "#999", marginBottom: 8 }}>
                {q.description}
              </div>
            )}
            {q.type === "evaluation_score" ? (
              <EvalQuestionField
                q={q}
                value={answers[q.id]}
                onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
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
  q: EvalTemplate["questions"][number];
  value: any;
  onChange: (value: any) => void;
}) {
  const selectedScore = value?.score;
  const caseRequired = q.caseRequiredScores?.includes(Number(selectedScore));
  return (
    <div className="eval-fill-question">
      <div className="eval-behavior-options">
        {(q.options || []).map((option) => (
          <button
            type="button"
            key={option.score}
            className={`eval-behavior-option ${selectedScore === option.score ? "selected" : ""}`}
            onClick={() =>
              onChange({ score: option.score, caseText: value?.caseText || "" })
            }
          >
            <span className="eval-behavior-score">{option.score} 分</span>
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <Input.TextArea
        rows={3}
        style={{ marginTop: 12 }}
        value={value?.caseText || ""}
        placeholder={`${q.casePrompt || "请填写具体案例"}${caseRequired ? "（当前分值必填）" : "（选填）"}`}
        status={
          caseRequired && !String(value?.caseText || "").trim()
            ? "warning"
            : undefined
        }
        onChange={(event) =>
          onChange({ score: selectedScore, caseText: event.target.value })
        }
      />
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
