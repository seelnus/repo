import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  QRCode,
  Radio,
  Rate,
  Result,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { http, fillHttp, downloadFile } from './App';

// ── 类型（宽松定义，够用即可）──
interface Cycle {
  id: number;
  name: string;
  scopeDepartment: string | null;
  selfSurveyId: number | null;
  peerSurveyId: number | null;
  leaderSurveyId: number | null;
  status: string;
  relationCount?: number;
  createdAt?: string;
}
interface SurveyLite { id: number; title: string }
interface ContactLite { id: number; name: string; department?: string | null; position?: string | null; tags?: string | null }

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  draft: { text: '草稿', color: 'default' },
  published: { text: '已发布', color: 'green' },
  closed: { text: '已关闭', color: 'red' },
};
const TYPE_LABEL: Record<string, string> = { self: '自评', peer: '他评', leader: '领导评价' };

function useSurveys() {
  const [surveys, setSurveys] = useState<SurveyLite[]>([]);
  useEffect(() => {
    http.get('/admin/surveys').then((r) => setSurveys(r.data || [])).catch(() => {});
  }, []);
  return surveys;
}

// ============ 批次列表 ============
export function EvalCycleList() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const surveys = useSurveys();
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await http.get('/admin/eval/cycles');
      setCycles(data || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function handleCreate() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const { data } = await http.post('/admin/eval/cycles', values);
      message.success('批次已创建');
      setModalOpen(false);
      form.resetFields();
      navigate(`/eval/${data.id}`);
    } catch (e: any) {
      message.error(e.response?.data?.message || '创建失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await http.delete(`/admin/eval/cycles/${id}`);
      message.success('已删除');
      load();
    } catch (e: any) {
      message.error(e.response?.data?.message || '删除失败');
    }
  }

  const surveyOptions = surveys.map((s) => ({ label: s.title, value: s.id }));

  return (
    <Card
      title="360 环评批次"
      extra={<Button type="primary" onClick={() => setModalOpen(true)}>新建批次</Button>}
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={cycles}
        pagination={false}
        columns={[
          { title: '批次名称', dataIndex: 'name' },
          { title: '参评范围（部门）', dataIndex: 'scopeDepartment', render: (v) => v || <Typography.Text type="secondary">未设置</Typography.Text> },
          { title: '关系数', dataIndex: 'relationCount', width: 100 },
          { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => <Tag color={STATUS_LABEL[s]?.color}>{STATUS_LABEL[s]?.text || s}</Tag> },
          {
            title: '操作',
            width: 180,
            render: (_: any, r: Cycle) => (
              <Space>
                <Button type="link" onClick={() => navigate(`/eval/${r.id}`)}>进入配置</Button>
                <Popconfirm title="删除该批次？关系一并删除" onConfirm={() => handleDelete(r.id)}>
                  <Button type="link" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal title="新建评价批次" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleCreate} confirmLoading={saving} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="批次名称" rules={[{ required: true, message: '请输入批次名称' }]}>
            <Input placeholder="如：2026 Q2 技术部 360 环评" />
          </Form.Item>
          <Form.Item name="scopeDepartment" label="参评范围（部门/组）" tooltip="按联系人的“部门”字段分组，同部门的人相互评价">
            <Input placeholder="如：技术组（需与联系人部门字段一致）" />
          </Form.Item>
          <Form.Item name="selfSurveyId" label="自评问卷模板">
            <Select allowClear showSearch optionFilterProp="label" options={surveyOptions} placeholder="选择一份问卷作为自评模板" />
          </Form.Item>
          <Form.Item name="peerSurveyId" label="他评问卷模板">
            <Select allowClear showSearch optionFilterProp="label" options={surveyOptions} placeholder="选择一份问卷作为他评模板" />
          </Form.Item>
          <Form.Item name="leaderSurveyId" label="领导评价问卷模板（可选）">
            <Select allowClear showSearch optionFilterProp="label" options={surveyOptions} placeholder="领导单独用的问卷" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ============ 批次详情（配置 / 生成 / 复核 / 关系）============
export function EvalCycleDetail() {
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
  useEffect(() => { loadCycle(); }, [cycleId]);

  function copyLink() {
    navigator.clipboard?.writeText(fillUrl).then(() => message.success('链接已复制')).catch(() => message.warning('复制失败，请手动复制'));
  }

  async function handleExport() {
    try {
      await downloadFile(`/admin/eval/cycles/${cycleId}/export`, `环评结果-批次${cycleId}.xlsx`);
    } catch (e: any) {
      message.error('导出失败');
    }
  }

  if (!cycle) return null;

  return (
    <Card
      title={<Space><Button type="link" onClick={() => navigate('/eval')}>← 返回</Button>{cycle.name}<Tag color={STATUS_LABEL[cycle.status]?.color}>{STATUS_LABEL[cycle.status]?.text || cycle.status}</Tag></Space>}
      extra={<Space><Button type="primary" onClick={() => setShareOpen(true)}>分享给员工</Button><Button onClick={handleExport}>导出结果 CSV</Button></Space>}
    >
      <Modal title="分享给员工填写" open={shareOpen} onCancel={() => setShareOpen(false)} footer={null}>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="整个批次只有这一个入口链接，发给全组人即可。员工用企业微信打开/扫码登录后，只会看到分配给自己的自评 + 他评。" />
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <QRCode value={fillUrl} size={180} />
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input readOnly value={fillUrl} />
          <Button onClick={copyLink}>复制</Button>
        </Space.Compact>
      </Modal>
      <Tabs
        defaultActiveKey="config"
        items={[
          { key: 'config', label: '① 配置', children: <ConfigTab cycle={cycle} onSaved={loadCycle} /> },
          { key: 'generate', label: '② 生成关系', children: <GenerateTab cycleId={cycleId} /> },
          { key: 'review', label: '③ 复核列表', children: <ReviewTab cycleId={cycleId} /> },
          { key: 'relations', label: '④ 关系明细 / 人工配置', children: <RelationsTab cycleId={cycle} /> },
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
      message.success('已保存');
      onSaved();
    } catch (e: any) {
      message.error(e.response?.data?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const surveyOptions = surveys.map((s) => ({ label: s.title, value: s.id }));
  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 520 }}>
      <Form.Item name="name" label="批次名称" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="scopeDepartment" label="参评范围（部门/组）"><Input placeholder="需与联系人部门字段一致" /></Form.Item>
      <Form.Item name="selfSurveyId" label="自评问卷模板"><Select allowClear showSearch optionFilterProp="label" options={surveyOptions} /></Form.Item>
      <Form.Item name="peerSurveyId" label="他评问卷模板"><Select allowClear showSearch optionFilterProp="label" options={surveyOptions} /></Form.Item>
      <Form.Item name="leaderSurveyId" label="领导评价问卷模板（可选）"><Select allowClear showSearch optionFilterProp="label" options={surveyOptions} /></Form.Item>
      <Form.Item name="status" label="批次状态"><Select options={[{ label: '草稿', value: 'draft' }, { label: '已发布', value: 'published' }, { label: '已关闭', value: 'closed' }]} /></Form.Item>
      <Button type="primary" loading={saving} onClick={save}>保存配置</Button>
      <Alert style={{ marginTop: 16 }} type="info" showIcon message="领导识别：在“联系人”里给领导的标签(tags)加上“领导”二字即可，生成关系时会自动跳过领导、留给人工配置。" />
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
      const { data } = await http.post(`/admin/eval/cycles/${cycleId}/generate`);
      setReport(data);
      message.success('已生成');
    } catch (e: any) {
      message.error(e.response?.data?.message || '生成失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Alert type="warning" style={{ marginBottom: 16 }} message="重新生成只覆盖“自动生成(auto)”的关系，人工配置(manual)的不会被冲掉。" />
      <Button type="primary" loading={loading} onClick={generate}>一键生成普通员工评价关系</Button>
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
          <div style={{ marginTop: 12, color: '#888' }}>
            校验：普通员工 {report.normalCount} 人 ⇒ 应为 {report.normalCount} 份自评 + {report.normalCount * (report.normalCount - 1)} 份他评 = {report.normalCount * report.normalCount} 条
          </div>
          {report.warnings?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {report.warnings.map((w: string, i: number) => (
                <Alert key={i} type="error" style={{ marginBottom: 8 }} message={w} />
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
  useEffect(() => { load(); }, [cycleId]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    return onlyAnomaly ? all.filter((r: any) => r.status === '异常') : all;
  }, [data, onlyAnomaly]);

  const s = data?.summary;
  return (
    <div>
      <Space size="large" style={{ marginBottom: 16 }} wrap>
        <Statistic title="参评总数" value={s?.total ?? 0} />
        <Statistic title="已完整" value={s?.complete ?? 0} valueStyle={{ color: '#3f8600' }} />
        <Statistic title="异常" value={s?.anomaly ?? 0} valueStyle={{ color: '#cf1322' }} />
        <Button onClick={load}>刷新</Button>
        <span>仅看异常 <Switch checked={onlyAnomaly} onChange={setOnlyAnomaly} /></span>
      </Space>
      {s && (
        <div style={{ marginBottom: 12 }}>
          <Space wrap>
            {Object.entries(s.byType).map(([k, v]: any) => v > 0 && <Tag key={k} color="red">{k}: {v}</Tag>)}
          </Space>
        </div>
      )}
      <Table
        rowKey="contactId"
        loading={loading}
        dataSource={rows}
        pagination={false}
        rowClassName={(r: any) => (r.status === '异常' ? 'eval-row-anomaly' : '')}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '部门', dataIndex: 'department', render: (v) => v || '—' },
          { title: '角色', dataIndex: 'isLeader', width: 80, render: (v: boolean) => (v ? <Tag color="gold">领导</Tag> : '普通') },
          { title: '自评', dataIndex: 'hasSelf', width: 90, render: (v: boolean, r: any) => (v ? (r.selfSubmitted ? <Tag color="green">已填</Tag> : <Tag>待填</Tag>) : <Tag color="red">未配</Tag>) },
          { title: '被几人评', dataIndex: 'ratedByCount', width: 100, render: (v: number, r: any) => `${r.ratedBySubmitted}/${v}` },
          { title: '评几人', dataIndex: 'ratingCount', width: 100, render: (v: number, r: any) => `${r.ratingSubmitted}/${v}` },
          { title: '来源', dataIndex: 'source', width: 90, render: (v: string) => ({ auto: '自动', manual: '人工', mixed: '混合', none: '未覆盖' }[v] || v) },
          { title: '状态', dataIndex: 'status', width: 160, render: (st: string, r: any) => (st === '完整' ? <Tag color="green">完整</Tag> : <Space size={4} wrap>{r.anomalies.map((a: string) => <Tag color="red" key={a}>{a}</Tag>)}</Space>) },
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
  const relType = Form.useWatch('relationType', form);

  async function load() {
    setLoading(true);
    try {
      const { data } = await http.get(`/admin/eval/cycles/${cid}/relations`);
      setRows(data || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [cid]);
  useEffect(() => { http.get('/admin/contacts').then((r) => setContacts(r.data || [])).catch(() => {}); }, []);

  async function addRelation() {
    const values = await form.validateFields();
    if (values.relationType === 'self') values.rateeContactId = values.raterContactId;
    setSaving(true);
    try {
      await http.post(`/admin/eval/cycles/${cid}/relations`, values);
      message.success('已添加');
      setModalOpen(false);
      form.resetFields();
      load();
    } catch (e: any) {
      message.error(e.response?.data?.message || '添加失败');
    } finally {
      setSaving(false);
    }
  }

  async function del(rid: number) {
    try {
      await http.delete(`/admin/eval/relations/${rid}`);
      message.success('已删除');
      load();
    } catch (e: any) {
      message.error(e.response?.data?.message || '删除失败');
    }
  }

  const contactOptions = contacts.map((c) => ({ label: `${c.name}${c.department ? `（${c.department}）` : ''}`, value: c.id }));
  const surveyOptions = surveys.map((s) => ({ label: s.title, value: s.id }));

  return (
    <div>
      <Button type="primary" style={{ marginBottom: 16 }} onClick={() => setModalOpen(true)}>人工添加关系（领导/异常补配）</Button>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        size="small"
        pagination={{ pageSize: 20 }}
        columns={[
          { title: '评价人', dataIndex: 'raterName' },
          { title: '被评人', dataIndex: 'rateeName' },
          { title: '类型', dataIndex: 'relationType', width: 100, render: (v: string) => TYPE_LABEL[v] || v },
          { title: '来源', dataIndex: 'source', width: 90, render: (v: string) => (v === 'manual' ? <Tag color="blue">人工</Tag> : '自动') },
          { title: '已填', dataIndex: 'done', width: 80, render: (v: boolean) => (v ? <Tag color="green">是</Tag> : '否') },
          {
            title: '操作', width: 90,
            render: (_: any, r: any) => (
              <Popconfirm title="删除该关系？" onConfirm={() => del(r.id)}>
                <Button type="link" danger size="small" disabled={r.done}>删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      <Modal title="人工添加评价关系" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={addRelation} confirmLoading={saving} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false} initialValues={{ relationType: 'leader' }}>
          <Form.Item name="relationType" label="关系类型" rules={[{ required: true }]}>
            <Select options={[{ label: '自评', value: 'self' }, { label: '他评', value: 'peer' }, { label: '领导评价', value: 'leader' }]} />
          </Form.Item>
          <Form.Item name="raterContactId" label="评价人" rules={[{ required: true, message: '请选择评价人' }]}>
            <Select showSearch optionFilterProp="label" options={contactOptions} placeholder="谁来评" />
          </Form.Item>
          {relType !== 'self' && (
            <Form.Item name="rateeContactId" label="被评人" rules={[{ required: true, message: '请选择被评人' }]}>
              <Select showSearch optionFilterProp="label" options={contactOptions} placeholder="评价谁" />
            </Form.Item>
          )}
          <Form.Item name="surveyId" label="问卷模板（留空则用批次默认模板）">
            <Select allowClear showSearch optionFilterProp="label" options={surveyOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ============ 填写端（员工）============
export function EvalFillPage() {
  const { message } = AntApp.useApp();
  const [token, setToken] = useState(localStorage.getItem('fill_token') || '');
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [picked, setPicked] = useState<number | undefined>();
  const [devEnabled, setDevEnabled] = useState(true);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  // 企业微信登录回调：URL 里带 fill_token 就存下来并清理地址栏
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get('fill_token');
    if (t) {
      localStorage.setItem('fill_token', t);
      setToken(t);
      window.history.replaceState({}, '', '/eval-fill');
    }
  }, []);

  useEffect(() => {
    if (!token) {
      fillHttp.get('/eval-dev/contacts').then((r) => setContacts(r.data || [])).catch(() => setDevEnabled(false));
    }
  }, [token]);

  function wecomLogin() {
    window.location.href = `/api/wecom/oauth/url?state=${encodeURIComponent('/eval-fill')}`;
  }

  async function loadTasks() {
    setLoading(true);
    try {
      const { data } = await fillHttp.get('/eval/tasks');
      setGroups(data || []);
    } catch (e: any) {
      if (e.response?.status === 401) { localStorage.removeItem('fill_token'); setToken(''); }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (token) loadTasks(); }, [token]);

  async function devLogin() {
    if (!picked) { message.warning('请选择一个员工身份'); return; }
    try {
      const { data } = await fillHttp.post('/eval-dev/login', { contactId: picked });
      localStorage.setItem('fill_token', data.token);
      setToken(data.token);
      message.success(`已以「${data.name}」身份登录`);
    } catch (e: any) {
      message.error(e.response?.data?.message || '登录失败');
    }
  }
  function logout() { localStorage.removeItem('fill_token'); setToken(''); setGroups([]); }

  if (active !== null) {
    return <FillTaskView relationId={active} onDone={() => { setActive(null); loadTasks(); }} onBack={() => setActive(null)} />;
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 440, margin: '80px auto' }}>
        <Card title="360 环评 · 登录填写">
          <Button type="primary" block size="large" onClick={wecomLogin}>企业微信登录</Button>
          {devEnabled && (
            <>
              <Divider>本地测试（不走企微）</Divider>
              <Alert type="info" showIcon style={{ marginBottom: 16 }} message="本地没有企业微信，用下面的下拉选一个员工身份进入。服务器上请用上方“企业微信登录”。" />
              <Select
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                placeholder="选择你要假装的员工"
                value={picked}
                onChange={setPicked}
                options={contacts.map((c) => ({ label: `${c.name}${c.department ? `（${c.department}）` : ''}`, value: c.id }))}
              />
              <Button block style={{ marginTop: 16 }} onClick={devLogin}>进入填写（测试身份）</Button>
            </>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '24px auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>待我填写</Typography.Title>
        <Button onClick={logout}>切换身份</Button>
      </div>
      {loading ? <Spin /> : groups.length === 0 ? <Empty description="暂无待填写任务（确认批次已发布、且有分配给你的关系）" /> : groups.map((g) => (
        <Card key={g.cycleId} title={g.cycleName} style={{ marginBottom: 16 }}>
          {g.tasks.map((t: any) => (
            <div key={t.relationId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f0f0f0' }}>
              <span><Tag>{TYPE_LABEL[t.type] || t.type}</Tag> {t.rateeName} · {t.surveyTitle}</span>
              {t.done ? <Tag color="green">已完成</Tag> : <Button type="primary" size="small" onClick={() => setActive(t.relationId)}>去填写</Button>}
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function FillTaskView({ relationId, onDone, onBack }: { relationId: number; onDone: () => void; onBack: () => void }) {
  const { message } = AntApp.useApp();
  const [task, setTask] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { fillHttp.get(`/eval/tasks/${relationId}`).then((r) => setTask(r.data)).catch(() => {}); }, [relationId]);

  if (!task) return <div style={{ maxWidth: 720, margin: '80px auto', textAlign: 'center' }}><Spin /></div>;
  if (task.done) {
    return <div style={{ maxWidth: 720, margin: '40px auto' }}><Result status="success" title="这份你已经填过了" extra={<Button onClick={onBack}>返回列表</Button>} /></div>;
  }
  const questions: any[] = task.survey?.schemaJson?.questions || [];

  async function submit() {
    for (const q of questions) {
      if (q.required && q.type !== 'description') {
        const v = answers[q.id];
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) { message.warning(`请填写：${q.label}`); return; }
      }
    }
    setSubmitting(true);
    try {
      await fillHttp.post(`/eval/tasks/${relationId}/submit`, { answers });
      message.success('提交成功');
      onDone();
    } catch (e: any) {
      message.error(e.response?.data?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '24px auto' }}>
      <Card title={<Space><Button type="link" onClick={onBack}>← 返回</Button>{task.type === 'self' ? '自评' : `评价 ${task.rateeName}`} · {task.survey.title}</Space>}>
        {questions.length === 0 && <Empty description="这份问卷还没有题目" />}
        {questions.map((q) => (
          <div key={q.id} style={{ marginBottom: 20 }}>
            {q.type !== 'description'
              ? <div style={{ marginBottom: 8, fontWeight: 500 }}>{q.label}{q.required && <span style={{ color: 'red' }}> *</span>}</div>
              : <div style={{ marginBottom: 8, color: '#555' }}>{q.label}</div>}
            {q.description && <div style={{ color: '#999', marginBottom: 8 }}>{q.description}</div>}
            <QuestionField q={q} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
          </div>
        ))}
        <Divider />
        <Button type="primary" loading={submitting} onClick={submit}>提交</Button>
      </Card>
    </div>
  );
}

function QuestionField({ q, value, onChange }: { q: any; value: any; onChange: (v: any) => void }) {
  switch (q.type) {
    case 'description':
      return null;
    case 'radio':
      return (
        <Radio.Group value={value} onChange={(e) => onChange(e.target.value)}>
          <Space direction="vertical">{(q.options || []).map((o: string) => <Radio key={o} value={o}>{o}</Radio>)}</Space>
        </Radio.Group>
      );
    case 'checkbox':
      return <Checkbox.Group value={value || []} onChange={onChange} options={(q.options || []).map((o: string) => ({ label: o, value: o }))} />;
    case 'rating':
      return <Rate count={q.maxScore || 5} value={value} onChange={onChange} />;
    case 'textarea':
      return <Input.TextArea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <DatePicker value={value ? dayjs(value) : null} onChange={(_, ds) => onChange(ds)} />;
    case 'datetime':
      return <DatePicker showTime value={value ? dayjs(value) : null} onChange={(_, ds) => onChange(ds)} />;
    case 'text':
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}
