import {
  CalendarOutlined,
  CheckSquareOutlined,
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  FormOutlined,
  InboxOutlined,
  LinkOutlined,
  TableOutlined,
  PlusCircleOutlined,
  PlusOutlined,
  StarOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  QRCode,
  Result,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  Steps,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { UploadProps } from 'antd';
import axios from 'axios';
import Papa from 'papaparse';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

const API = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';
const FILE_BASE = API.replace(/\/api$/, '');
const appLocale = {
  ...zhCN,
  Popconfirm: {
    ...zhCN.Popconfirm,
    cancelText: 'No',
    okText: 'OK',
  },
  Modal: {
    ...zhCN.Modal,
    cancelText: 'No',
    okText: 'OK',
    justOkText: 'OK',
  },
};

type SurveyKind = 'case_collection' | 'assessment' | 'promotional_document';
type QuestionType = 'radio' | 'checkbox' | 'rating' | 'description' | 'text' | 'textarea' | 'file' | 'date' | 'datetime';

type Question = {
  id: string;
  type: QuestionType;
  label: string;
  description?: string;
  required?: boolean;
  options?: string[];
  maxScore?: number;
  visibleWhen?: { questionId: string; valueIn: string[] };
};

type SurveySchema = {
  questions: Question[];
  contentHtml?: string;
};

type Survey = {
  id: number;
  title: string;
  type: SurveyKind;
  status: 'draft' | 'published' | 'disabled';
  shareToken: string;
  schemaJson: SurveySchema;
  createdAt: string;
};

type Contact = {
  id: number;
  name: string;
  department?: string | null;
  jobNo?: string | null;
  phone: string;
  email?: string | null;
};

type WhitelistRecord = {
  id: number;
  surveyId: number;
  enabled: boolean;
  memberCount: number;
  updatedAt: string;
  survey: Survey;
  members?: Contact[];
};

const http = axios.create({ baseURL: API });
http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 填写端专用 axios 实例（携带 fill_token）
const fillHttp = axios.create({ baseURL: API });
fillHttp.interceptors.request.use((config) => {
  const token = localStorage.getItem('fill_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.clear();
      if (location.pathname !== '/login') location.href = '/login';
    }
    return Promise.reject(error);
  },
);

async function downloadFile(path: string, filename: string) {
  const response = await http.get(path, { responseType: 'blob' });
  const contentType = String(response.headers['content-type'] || 'text/csv;charset=utf-8;');
  const blob = new Blob([response.data], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const surveyTypeOptions = [
  { label: '问卷考核', value: 'assessment' },
  { label: '案例收集', value: 'case_collection' },
  { label: '宣传文档类', value: 'promotional_document' },
] satisfies Array<{ label: string; value: SurveyKind }>;

const paletteOptions: Array<{ type: QuestionType; label: string; icon: ReactNode }> = [
  { type: 'radio', label: '单选', icon: <span>◎</span> },
  { type: 'checkbox', label: '多选', icon: <CheckSquareOutlined /> },
  { type: 'rating', label: '评分打分', icon: <StarOutlined /> },
  { type: 'description', label: '文本描述', icon: <FileTextOutlined /> },
  { type: 'text', label: '单行文本', icon: <FormOutlined /> },
  { type: 'textarea', label: '多行文本', icon: <FileTextOutlined /> },
  { type: 'file', label: '图片/文件', icon: <UploadOutlined /> },
  { type: 'date', label: '日期/时间', icon: <CalendarOutlined /> },
];

function App() {
  return (
    <ConfigProvider
      locale={appLocale}
      theme={{
        token: {
          colorPrimary: '#4E73F5',
          colorLink: '#4E73F5',
          borderRadius: 8,
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/s/:shareToken" element={<FillPage />} />
            <Route path="/success" element={<Result status="success" title="提交成功" />} />
            <Route path="/*" element={<AdminShell />} />
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}

function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  async function onFinish(values: { phone: string; password: string }) {
    try {
      const { data } = await http.post('/admin/auth/login', values);
      localStorage.setItem('token', data.token);
      localStorage.setItem('admin', JSON.stringify(data.admin));
      navigate('/surveys');
    } catch (error: any) {
      message.error(error.response?.data?.message || '登录失败');
    }
  }

  return (
    <div className="login-page">
      {/* 左侧品牌面板 */}
      <div className="login-left">
        <div className="login-brand">
          <img src="/chuanghuo.png" alt="闯货" className="login-brand-icon" />
          <div className="login-brand-name">内部问卷系统</div>
          <div className="login-brand-sub">高效的企业内部调研与考核平台</div>
        </div>
        <ul className="login-features">
          <li><span className="login-feature-dot" />多类型问卷，灵活配置</li>
          <li><span className="login-feature-dot" />白名单管控，精准触达</li>
          <li><span className="login-feature-dot" />实时数据统计，一键导出</li>
        </ul>
      </div>
      {/* 右侧表单区 */}
      <div className="login-right">
        <div className="login-card">
          <Typography.Title level={3} style={{ margin: '0 0 28px', color: 'var(--text-primary)' }}>欢迎登录</Typography.Title>
          <Form layout="vertical" onFinish={onFinish}>
            <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }]}>
              <Input size="large" placeholder="请输入手机号" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password size="large" placeholder="请输入密码" />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              className="login-submit-btn"
            >
              登录
            </Button>
          </Form>
        </div>
      </div>
    </div>
  );
}

function AdminShell() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/login" replace />;

  return (
    <Layout className="app-shell">
      <Layout.Sider width={216} theme="dark" className="app-sider">
        <div className="sider-logo">
          <span className="sider-logo-icon">📋</span>
          <span className="sider-logo-text">内部问卷系统</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          onClick={({ key }) => navigate(key)}
          className="app-sider-menu"
          items={[
            { key: '/surveys', label: '问卷管理', icon: <FormOutlined /> },
            { key: '/whitelists', label: '白名单管理', icon: <TableOutlined /> },
            { key: '/contacts', label: '联系人', icon: <FileTextOutlined /> },
            { key: '/members', label: '后台成员', icon: <CheckSquareOutlined /> },
          ]}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="app-header">
          <div className="app-header-title">{
            { '/surveys': '问卷管理', '/whitelists': '白名单管理', '/contacts': '联系人', '/members': '后台成员' }[location.pathname] || '问卷管理'
          }</div>
          <Button
            onClick={() => {
              localStorage.clear();
              navigate('/login');
            }}
          >
            退出登录
          </Button>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Routes>
            <Route path="/" element={<Navigate to="/surveys" />} />
            <Route path="/surveys" element={<SurveyList />} />
            <Route path="/surveys/new" element={<SurveyEditor />} />
            <Route path="/surveys/:id/edit" element={<SurveyEditor />} />
            <Route path="/surveys/:id/share" element={<SharePage />} />
            <Route path="/surveys/:id/responses" element={<ResponsesPage />} />
            <Route path="/whitelists" element={<WhitelistListPage />} />
            <Route path="/whitelists/new" element={<WhitelistEditorPage />} />
            <Route path="/whitelists/:surveyId/edit" element={<WhitelistEditorPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/members" element={<MembersPage />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function SurveyList() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Survey[]>([]);
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState<SurveyKind | undefined>();

  async function load(filters?: { keyword?: string; type?: SurveyKind }) {
    const nextKeyword = filters?.keyword ?? keyword;
    const nextType = filters?.type ?? type;
    const res = await http.get('/admin/surveys', { params: { keyword: nextKeyword, type: nextType } });
    setData(res.data);
  }

  useEffect(() => {
    load();
  }, []);

  async function setStatus(survey: Survey, checked: boolean) {
    await http.put(`/admin/surveys/${survey.id}/status`, { status: checked ? 'published' : 'disabled' });
    message.success('状态已更新');
    load();
  }

  const thisMonth = new Date().toISOString().slice(0, 7);
  const stats = {
    total: data.length,
    enabled: data.filter((s) => s.status === 'published').length,
    disabled: data.filter((s) => s.status === 'disabled').length,
    newThisMonth: data.filter((s) => s.createdAt?.startsWith(thisMonth)).length,
  };

  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">问卷管理</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/surveys/new')} className="gradient-btn">
          新建问卷
        </Button>
      </div>
      {/* 统计卡片行 */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-card-icon" style={{ background: 'linear-gradient(135deg, #4E73F5, #7C54E8)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
          </div>
          <div>
            <div className="stat-card-value">{stats.total}</div>
            <div className="stat-card-label">问卷总数</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon" style={{ background: 'linear-gradient(135deg, #52C41A, #73D13D)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="9 12 11 14 15 10"/>
            </svg>
          </div>
          <div>
            <div className="stat-card-value">{stats.enabled}</div>
            <div className="stat-card-label">已启用</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon" style={{ background: 'linear-gradient(135deg, #FF7A45, #FF9C6E)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="10" y1="15" x2="10" y2="9"/>
              <line x1="14" y1="15" x2="14" y2="9"/>
            </svg>
          </div>
          <div>
            <div className="stat-card-value">{stats.disabled}</div>
            <div className="stat-card-label">已禁用</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon" style={{ background: 'linear-gradient(135deg, #13C2C2, #36CFC9)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
              <line x1="12" y1="14" x2="12" y2="18"/>
              <line x1="10" y1="16" x2="14" y2="16"/>
            </svg>
          </div>
          <div>
            <div className="stat-card-value">{stats.newThisMonth}</div>
            <div className="stat-card-label">本月新增</div>
          </div>
        </div>
      </div>
      <Card>
        <div className="toolbar">
          <div className="toolbar-left">
            <Input.Search
              placeholder="搜索问卷名称"
              allowClear
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onSearch={(value) => {
                setKeyword(value);
                load({ keyword: value });
              }}
              style={{ width: 240 }}
            />
            <Select
              allowClear
              placeholder="类型"
              style={{ width: 180 }}
              value={type}
              onChange={(value) => {
                setType(value);
                load({ type: value });
              }}
              options={surveyTypeOptions}
            />
            <Button onClick={() => load({ keyword, type })}>搜索</Button>
          </div>
        </div>
        <Table
          rowKey="id"
          dataSource={data}
          columns={[
            { title: '问卷名称', dataIndex: 'title' },
            {
              title: '类型',
              dataIndex: 'type',
              render: (value: SurveyKind) => <Tag color={surveyTypeColor(value)}>{surveyTypeLabel(value)}</Tag>,
            },
            {
              title: '启用状态',
              dataIndex: 'status',
              render: (_: unknown, row: Survey) => (
                <Switch
                  checked={row.status === 'published'}
                  checkedChildren="已启用"
                  unCheckedChildren="未启用"
                  onChange={(checked) => setStatus(row, checked)}
                />
              ),
            },
            { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => new Date(value).toLocaleString() },
            {
              title: '操作',
              render: (_: unknown, row: Survey) => (
                <Space>
                  <Button icon={<EditOutlined />} onClick={() => navigate(`/surveys/${row.id}/edit`)}>
                    编辑
                  </Button>
                  <Button icon={<LinkOutlined />} onClick={() => navigate(`/surveys/${row.id}/share`)}>
                    分享
                  </Button>
                  <Button icon={<EyeOutlined />} onClick={() => navigate(`/surveys/${row.id}/responses`)}>
                    数据
                  </Button>
                  <Button icon={<DownloadOutlined />} onClick={() => downloadFile(`/admin/surveys/${row.id}/export`, `survey-${row.id}.csv`)}>
                    导出 CSV
                  </Button>
                  <Popconfirm title="确认删除该问卷？" cancelText="No" onConfirm={async () => { await http.delete(`/admin/surveys/${row.id}`); load(); }}>
                    <Button danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

function SurveyEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ title: string; type: SurveyKind }>();
  const surveyType = Form.useWatch('type', form) || 'assessment';
  const surveyTitle = Form.useWatch('title', form);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [contentHtml, setContentHtml] = useState('');
  const [saving, setSaving] = useState(false);
  const activeQuestionType = questions.find((item) => item.id === activeId)?.type;

  useEffect(() => {
    if (!id) return;
    http.get(`/admin/surveys/${id}`).then(({ data }: { data: Survey }) => {
      form.setFieldsValue({ title: data.title, type: data.type });
      setQuestions(data.schemaJson?.questions || []);
      setActiveId(data.schemaJson?.questions?.[0]?.id);
      setContentHtml(data.schemaJson?.contentHtml || '');
    });
  }, [id]);

  function addQuestion(type: QuestionType) {
    const next: Question = {
      id: `q${Date.now()}`,
      type,
      label: '',
      description: type === 'description' ? '请输入考题说明' : '',
      required: false,
      options: type === 'radio' || type === 'checkbox' ? ['选项'] : [],
      maxScore: type === 'rating' ? 10 : undefined,
    };
    setQuestions((prev) => [...prev, next]);
    setActiveId(next.id);
  }

  async function save(publish = false) {
    if (saving) return;
    const values = await form.validateFields();

    setSaving(true);
    try {
      if (values.type === 'promotional_document') {
        if (!stripHtml(contentHtml).trim()) {
          message.error('请填写宣传文档内容');
          return;
        }
        const payload = {
          ...values,
          schemaJson: {
            questions: [],
            contentHtml,
          },
        };
        const res = id ? await http.put(`/admin/surveys/${id}`, payload) : await http.post('/admin/surveys', payload);
        if (publish) {
          await http.post(`/admin/surveys/${res.data.id}/publish`);
          message.success('已发布');
          navigate('/surveys');
        } else {
          navigate(`/surveys/${res.data.id}/share`);
        }
        return;
      }

      const normalized = questions.map((question) => ({
        ...question,
        label: question.type === 'description' ? (question.description || '').trim() : question.label?.trim(),
        description: question.description?.trim() || '',
        options: ['radio', 'checkbox'].includes(question.type)
          ? (question.options || []).map((item) => item.trim()).filter(Boolean)
          : [],
        maxScore: question.type === 'rating' ? 10 : question.maxScore,
      }));

      if (normalized.some((question) => !question.label)) {
        message.error('请补全题目标题');
        return;
      }
      if (normalized.some((question) => ['radio', 'checkbox'].includes(question.type) && (question.options || []).length === 0)) {
        message.error('选择题至少需要一个选项');
        return;
      }

      const payload = { ...values, schemaJson: { questions: normalized, contentHtml: '' } };
      const res = id ? await http.put(`/admin/surveys/${id}`, payload) : await http.post('/admin/surveys', payload);
      if (publish) {
        await http.post(`/admin/surveys/${res.data.id}/publish`);
        message.success('已发布');
        navigate('/surveys');
      } else {
        navigate(`/surveys/${res.data.id}/share`);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="page-title">{id ? '编辑问卷' : '新建问卷'}</h1>
      <div className="builder-layout">
        <aside className="builder-palette">
          {surveyType !== 'promotional_document' ? (
            <>
              <Typography.Text className="palette-title">选择题型</Typography.Text>
              <div className="palette-grid">
                {paletteOptions.slice(0, 3).map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className={`palette-button ${activeQuestionType === item.type ? 'active' : ''}`}
                    onClick={() => addQuestion(item.type)}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
              <Typography.Text className="palette-title">文本输入</Typography.Text>
              <div className="palette-grid">
                {paletteOptions.slice(3, 6).map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className={`palette-button ${activeQuestionType === item.type ? 'active' : ''}`}
                    onClick={() => addQuestion(item.type)}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
              <Typography.Text className="palette-title">高级题型</Typography.Text>
              <div className="palette-grid">
                {paletteOptions.slice(6).map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className={`palette-button ${activeQuestionType === item.type ? 'active' : ''}`}
                    onClick={() => addQuestion(item.type)}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Typography.Text className="palette-title">宣传文档说明</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                这种类型用于发布培训资料、入职指引、宣传内容等。编辑器支持标题、段落、链接和图片排版，发布后前台按富文本内容展示，不要求填写答卷。
              </Typography.Paragraph>
            </>
          )}
        </aside>

        <main className="builder-canvas">
          {/* 渐变 Banner 预览头图 */}
          <div className="canvas-header-banner">
            <div className="canvas-banner-tag">{surveyTypeLabel(surveyType)}</div>
            <div className="canvas-banner-title">
              {surveyTitle || (id ? '编辑问卷' : '新建问卷')}
            </div>
          </div>
          <Card className="survey-meta-card">
            <Form form={form} layout="vertical" initialValues={{ type: 'assessment' }}>
              <Form.Item name="title" label="问卷名称" rules={[{ required: true, message: '请输入问卷名称' }]}>
                <Input placeholder="请输入问卷名称" />
              </Form.Item>
              <Form.Item name="type" label="类型标签" rules={[{ required: true, message: '请选择类型标签' }]}>
                <Select options={surveyTypeOptions} />
              </Form.Item>
            </Form>
          </Card>

          {surveyType === 'promotional_document' ? (
            <RichTextSurveyEditor value={contentHtml} onChange={setContentHtml} />
          ) : (
            <div className="question-canvas">
              {questions.length === 0 ? (
                <div className="empty-builder">
                  <Typography.Title level={4}>从左侧选择题型开始创建问卷</Typography.Title>
                  <Typography.Text type="secondary">支持单选、多选、评分、文本、附件和日期题。</Typography.Text>
                </div>
              ) : (
                questions.map((question, index) => (
                  <QuestionEditor
                    key={question.id}
                    active={activeId === question.id}
                    question={question}
                    questions={questions}
                    onActivate={() => setActiveId(question.id)}
                    onChange={(next) => setQuestions((prev) => prev.map((item) => (item.id === question.id ? next : item)))}
                    onDelete={() => {
                      setQuestions((prev) => prev.filter((item) => item.id !== question.id));
                      if (activeId === question.id) {
                        setActiveId(undefined);
                      }
                    }}
                    index={index}
                  />
                ))
              )}
            </div>
          )}
        </main>

        <aside className="builder-actions">
          <Card title="操作">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button type="primary" block loading={saving} disabled={saving} onClick={() => save(false)}>
                分享
              </Button>
              <Button block loading={saving} disabled={saving} onClick={() => save(true)}>
                发布
              </Button>
              <Button block onClick={() => navigate('/surveys')}>
                返回
              </Button>
            </Space>
          </Card>
        </aside>
      </div>
    </>
  );
}

function RichTextSurveyEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { message } = AntApp.useApp();

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || '';
    }
  }, [value]);

  function syncEditor() {
    onChange(editorRef.current?.innerHTML || '');
  }

  function runCommand(command: string, commandValue?: string) {
    if (typeof document === 'undefined') return;
    editorRef.current?.focus();
    document.execCommand(command, false, commandValue);
    syncEditor();
  }

  function insertLink() {
    const url = window.prompt('请输入链接地址');
    if (url) runCommand('createLink', url);
  }

  async function uploadRichImage(file: File) {
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件');
      return '';
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error('图片不能超过 20MB');
      return '';
    }

    const formData = new FormData();
    formData.append('file', file);
    const { data } = await http.post('/uploads', formData);
    return `${FILE_BASE}${data.url}`;
  }

  function insertHtml(html: string) {
    if (typeof document === 'undefined') return;
    editorRef.current?.focus();
    document.execCommand('insertHTML', false, html);
    syncEditor();
  }

  async function insertImageFile(file: File) {
    setUploading(true);
    try {
      const url = await uploadRichImage(file);
      if (url) insertHtml(`<img src="${url}" alt="${file.name}" />`);
    } catch {
      message.error('图片上传失败，请稍后重试');
    } finally {
      setUploading(false);
    }
  }

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await insertImageFile(file);
  }

  async function replaceDataImages(html: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const images = Array.from(doc.querySelectorAll('img[src^="data:image/"]'));
    for (const image of images) {
      const src = image.getAttribute('src');
      if (!src) continue;
      const blob = await fetch(src).then((res) => res.blob());
      const extension = blob.type.split('/')[1] || 'png';
      const file = new File([blob], `pasted-${Date.now()}.${extension}`, { type: blob.type });
      const url = await uploadRichImage(file);
      if (url) image.setAttribute('src', url);
    }
    return doc.body.innerHTML;
  }

  async function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        await insertImageFile(file);
        return;
      }
    }

    const html = event.clipboardData.getData('text/html');
    if (html.includes('data:image/')) {
      event.preventDefault();
      setUploading(true);
      try {
        insertHtml(await replaceDataImages(html));
      } catch {
        message.error('粘贴图片处理失败，请使用上传图片按钮');
      } finally {
        setUploading(false);
      }
      return;
    }

    setTimeout(syncEditor);
  }

  function insertTable() {
    const rows = Number(window.prompt('请输入表格行数', '3') || 0);
    const cols = Number(window.prompt('请输入表格列数', '3') || 0);
    if (!rows || !cols) return;

    const safeRows = Math.min(Math.max(rows, 1), 12);
    const safeCols = Math.min(Math.max(cols, 1), 8);
    const cells = Array.from({ length: safeCols }, () => '<td><br /></td>').join('');
    const tableRows = Array.from({ length: safeRows }, () => `<tr>${cells}</tr>`).join('');
    insertHtml(`<table><tbody>${tableRows}</tbody></table><p><br /></p>`);
  }

  function clearFormat() {
    runCommand('removeFormat');
    runCommand('unlink');
  }

  return (
    <div className="question-canvas">
      <div className="rich-editor-shell">
        <div className="rich-editor-toolbar">
          <Button size="small" onClick={() => runCommand('bold')}>
            加粗
          </Button>
          <Button size="small" onClick={() => runCommand('insertUnorderedList')}>
            无序列表
          </Button>
          <Button size="small" onClick={() => runCommand('formatBlock', '<h1>')}>
            大标题
          </Button>
          <Button size="small" onClick={() => runCommand('formatBlock', '<h2>')}>
            小标题
          </Button>
          <Button size="small" icon={<LinkOutlined />} onClick={insertLink}>
            链接
          </Button>
          <Button size="small" icon={<UploadOutlined />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
            图片
          </Button>
          <Button size="small" icon={<TableOutlined />} onClick={insertTable}>
            表格
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={clearFormat}>
            清除格式
          </Button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleImageChange} />
        </div>
        <div
          ref={editorRef}
          className="rich-editor-content"
          contentEditable
          suppressContentEditableWarning
          onInput={(event) => onChange((event.target as HTMLDivElement).innerHTML)}
          onPaste={handlePaste}
          data-placeholder="请输入宣传文档内容，可包含标题、段落、链接、图片说明等。"
        />
      </div>
      <div className="rich-preview-card">
        <Typography.Title level={5}>预览</Typography.Title>
        <div className="rich-preview-body" dangerouslySetInnerHTML={{ __html: value || '<p style="color:#999">这里会显示文档预览</p>' }} />
      </div>
    </div>
  );
}

function QuestionEditor({
  active,
  question,
  questions,
  onActivate,
  onChange,
  onDelete,
  index,
}: {
  active: boolean;
  question: Question;
  questions: Question[];
  onActivate: () => void;
  onChange: (question: Question) => void;
  onDelete: () => void;
  index: number;
}) {
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [logicOpen, setLogicOpen] = useState(Boolean(question.visibleWhen));
  const optionQuestions = questions.filter((item) => ['radio', 'checkbox'].includes(item.type) && item.id !== question.id);
  const parent = optionQuestions.find((item) => item.id === question.visibleWhen?.questionId);
  const isChoice = ['radio', 'checkbox'].includes(question.type);

  function updateOption(optionIndex: number, value: string) {
    const options = [...(question.options || [])];
    options[optionIndex] = value;
    onChange({ ...question, options });
  }

  function removeOption(optionIndex: number) {
    onChange({ ...question, options: (question.options || []).filter((_, idx) => idx !== optionIndex) });
  }

  function openBatch() {
    setBatchText((question.options || []).join('\n'));
    setBatchOpen(true);
  }

  function applyBatch() {
    onChange({
      ...question,
      options: batchText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    });
    setBatchOpen(false);
  }

  return (
    <div className={`builder-question ${active ? 'active' : ''}`} onClick={onActivate}>
      <div className="question-head">
        <div className="question-heading">
          <div className="question-heading-main">
            <Typography.Text className="question-number">
              {question.required && <span className="required-mark">*</span>}
              {index + 1}
            </Typography.Text>
            {question.type !== 'description' ? (
              <QuestionTitleTextArea value={question.label} onChange={(value) => onChange({ ...question, label: value })} />
            ) : (
              <Typography.Text strong className="question-heading-title">{question.label || '请输入题目标题'}</Typography.Text>
            )}
            <span className="question-type-tag">{typeLabel(question.type)}</span>
          </div>
        </div>
        <Popconfirm title="确认删除这道题？" cancelText="No" onConfirm={onDelete}>
          <Button className="question-delete-button" size="small" icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      </div>

      <Form layout="vertical" style={{ marginTop: 12 }}>
        {question.type === 'description' ? (
          <Form.Item label="文本描述" required>
            <Input.TextArea
              rows={5}
              value={question.description}
              placeholder="请输入考题说明"
              onChange={(event) => onChange({ ...question, label: event.target.value, description: event.target.value })}
            />
          </Form.Item>
        ) : (
          <>
            <Input
              variant="borderless"
              className="question-desc-input"
              value={question.description}
              placeholder="请输入题目说明（选填）"
              onChange={(event) => onChange({ ...question, description: event.target.value })}
            />
          </>
        )}

        {isChoice && (
          <div className="option-editor">
            {(question.options || []).map((option, optionIndex) => (
              <div className="option-row" key={`${question.id}-${optionIndex}`}>
                <span className={`choice-symbol ${question.type === 'checkbox' ? 'checkbox-symbol' : ''}`} />
                <Input
                  variant="borderless"
                  className="option-input"
                  value={option}
                  placeholder="选项"
                  onChange={(event) => updateOption(optionIndex, event.target.value)}
                />
                <Button className="option-delete-button" type="text" danger icon={<DeleteOutlined />} onClick={() => removeOption(optionIndex)} />
              </div>
            ))}
            <Space className="option-actions" split={<span className="option-action-divider">|</span>}>
              <Button
                className="option-action-button"
                type="text"
                icon={<PlusCircleOutlined />}
                onClick={() => onChange({ ...question, options: [...(question.options || []), '选项'] })}
              >
                添加选项
              </Button>
              <Button className="option-action-button" type="text" onClick={openBatch}>
                批量编辑
              </Button>
            </Space>
          </div>
        )}

        {question.type === 'text' && <Input placeholder="填写者将在这里输入单行文本" disabled />}
        {question.type === 'textarea' && <Input.TextArea rows={4} placeholder="填写者将在这里输入多行文本" disabled />}
        {question.type === 'rating' && (
          <div className="rating-preview">
            <div className="rating-help">评分范围默认为 10 分，填写者可选择 1-10 分</div>
            <div className="rating-labels">
              <span>非常不满意</span>
              <span>非常满意</span>
            </div>
            <div className="rating-scale">
              {Array.from({ length: 10 }, (_, score) => (
                <button key={score + 1} type="button" className="rating-score" disabled>
                  {score + 1}
                </button>
              ))}
            </div>
          </div>
        )}
        {question.type === 'file' && (
          <Button disabled icon={<UploadOutlined />}>
            填写者上传文件
          </Button>
        )}
        {(question.type === 'date' || question.type === 'datetime') && <input className="native-date" disabled placeholder="填写者选择日期" />}

        {question.type !== 'description' && (
          <>
            <div className="question-footer">
              <Checkbox checked={question.required} onChange={(event) => onChange({ ...question, required: event.target.checked })}>
                必填
              </Checkbox>
              <button type="button" className="logic-toggle" onClick={() => setLogicOpen((prev) => !prev)}>
                显示条件
              </button>
            </div>

            {logicOpen && (
              <Space direction="vertical" className="logic-panel">
                <Select
                  className="logic-select"
                  allowClear
                  placeholder="触发题目"
                  value={question.visibleWhen?.questionId}
                  onChange={(value) =>
                    onChange({
                      ...question,
                      visibleWhen: value ? { questionId: value, valueIn: [] } : undefined,
                    })
                  }
                  options={optionQuestions.map((item) => ({ label: item.label || item.id, value: item.id }))}
                />
                {parent && (
                  <Select
                    className="logic-select"
                    mode="multiple"
                    placeholder="命中这些选项时显示"
                    value={question.visibleWhen?.valueIn}
                    onChange={(value) =>
                      onChange({
                        ...question,
                        visibleWhen: { questionId: parent.id, valueIn: value },
                      })
                    }
                    options={(parent.options || []).map((item) => ({ label: item, value: item }))}
                  />
                )}
              </Space>
            )}
          </>
        )}
      </Form>

      <Modal title="批量编辑选项" open={batchOpen} onCancel={() => setBatchOpen(false)} onOk={applyBatch} okText="应用" cancelText="取消">
        <Typography.Paragraph type="secondary">每行一个选项，保存后会替换当前选项列表。</Typography.Paragraph>
        <Input.TextArea rows={8} value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder={'选项1\n选项2\n选项3'} />
      </Modal>
    </div>
  );
}

function autoResizeTitle(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.max(32, element.scrollHeight)}px`;
}

function QuestionTitleTextArea({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    autoResizeTitle(titleRef.current);
  }, [value]);

  return (
    <textarea
      ref={titleRef}
      className="title-auto-resize"
      rows={1}
      value={value || ''}
      placeholder="请输入题目标题"
      onInput={(event) => autoResizeTitle(event.currentTarget)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function SharePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [survey, setSurvey] = useState<Survey>();

  useEffect(() => {
    http.get(`/admin/surveys/${id}`).then(({ data }) => setSurvey(data));
  }, [id]);

  if (!survey) return null;
  const url = `${location.origin}/s/${survey.shareToken}`;

  return (
    <Card title="分享与发布">
      <Space direction="vertical" size={16}>
        <QRCode value={url} />
        <Typography.Text copyable>{url}</Typography.Text>
        <Space>
          <Button
            type="primary"
            onClick={async () => {
              await http.post(`/admin/surveys/${id}/publish`);
              navigate('/surveys');
            }}
          >
            发布并分享
          </Button>
          <Button onClick={() => navigate('/surveys')}>返回</Button>
        </Space>
      </Space>
    </Card>
  );
}

function ResponsesPage() {
  const { id } = useParams();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [survey, setSurvey] = useState<Survey>();
  const [active, setActive] = useState<any>();
  const [form] = Form.useForm();

  const load = async () => {
    const [responsesRes, surveyRes] = await Promise.all([
      http.get(`/admin/surveys/${id}/responses`),
      http.get(`/admin/surveys/${id}`),
    ]);
    setRows(responsesRes.data);
    setSurvey(surveyRes.data);
  };

  useEffect(() => {
    load();
  }, [id]);

  function selectResponse(row: any) {
    setActive(row);
    form.resetFields();
  }

  const questions = (survey?.schemaJson?.questions || []).filter((question) => question.type !== 'description');

  return (
    <Card title="提交记录">
      <Table
        className="responses-table"
        rowKey="id"
        dataSource={rows}
        rowClassName={(row) => (active?.id === row.id ? 'response-row-active' : '')}
        onRow={(row) => ({
          onClick: () => selectResponse(row),
        })}
        columns={[
          { title: '提交人', render: (_: unknown, row: any) => row.wecomUser?.name || row.wecomUserid },
          { title: '提交时间', dataIndex: 'submittedAt', render: (value: string) => new Date(value).toLocaleString() },
          { title: '评分', render: (_: unknown, row: any) => row.comment?.score || '-' },
          {
            title: '操作',
            render: (_: unknown, row: any) => (
              <Button
                type="link"
                className="response-view-link"
                onClick={(event) => {
                  event.stopPropagation();
                  selectResponse(row);
                }}
              >
                查看/点评
              </Button>
            ),
          },
        ]}
      />

      <Drawer
        open={Boolean(active)}
        onClose={() => setActive(undefined)}
        width={340}
        closable={false}
        title={
          <div className="response-detail-title">
            <span>提交详情</span>
            <button type="button" className="response-detail-close" onClick={() => setActive(undefined)}>
              ×
            </button>
          </div>
        }
      >
        {active && (
          <div className="response-detail">
            <ResponseSubmitterInfo response={active} />
            <div className="qa-list">
              {questions.map((question, index) => (
                <ResponseAnswerItem key={question.id} question={question} index={index} value={active.answersJson?.[question.id]} />
              ))}
            </div>
            {active.comment ? (
              <Card size="small">
                评分：{active.comment.score}
                <br />
                点评：{active.comment.comment}
              </Card>
            ) : (
              <Form
                form={form}
                layout="vertical"
                onFinish={async (values) => {
                  await http.post(`/admin/responses/${active.id}/comment`, values);
                  message.success('已保存');
                  setActive(undefined);
                  load();
                }}
              >
                <Form.Item name="score" label="评分" rules={[{ required: true, message: '请输入评分' }]}>
                  <InputNumber className="response-comment-input" min={1} max={10} step={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="comment" label="点评">
                  <Input.TextArea className="response-comment-input" rows={4} />
                </Form.Item>
                <Button type="primary" htmlType="submit">
                  保存
                </Button>
              </Form>
            )}
          </div>
        )}
      </Drawer>
    </Card>
  );
}

function ResponseSubmitterInfo({ response }: { response: any }) {
  const name = response.wecomUser?.name || response.wecomUserid || '未知用户';
  const initial = String(name).trim().charAt(0) || '?';

  return (
    <div className="response-user">
      <div className="response-avatar">{initial}</div>
      <div className="response-user-meta">
        <div className="response-user-name">{name}</div>
        <div className="response-time">{new Date(response.submittedAt).toLocaleString()}</div>
      </div>
    </div>
  );
}

function ResponseAnswerItem({ question, index, value }: { question: Question; index: number; value: unknown }) {
  const formatted = formatAnswerValue(value);
  const empty = formatted === '';

  return (
    <div className="qa-item">
      <div className="qa-num">Q{index + 1}</div>
      <div className="qa-question">{question.label || question.id}</div>
      <div className={`qa-answer ${empty ? 'empty' : ''}`}>{empty ? '未作答' : formatted}</div>
    </div>
  );
}

function formatAnswerValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join('、') : '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function WhitelistListPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<WhitelistRecord[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRows((await http.get('/admin/whitelists')).data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="toolbar">
        <div>
          <h1 className="page-title">白名单管理</h1>
          <Typography.Text type="secondary">为指定问卷配置允许填写的联系人名单。</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/whitelists/new')}>
          新增白名单
        </Button>
      </div>
      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          footer={() => `共 ${rows.length} 个白名单配置`}
          columns={[
            { title: '问卷名称', dataIndex: ['survey', 'title'] },
            {
              title: '问卷类型',
              dataIndex: ['survey', 'type'],
              render: (value: SurveyKind) => <Tag color={surveyTypeColor(value)}>{surveyTypeLabel(value)}</Tag>,
            },
            {
              title: '白名单状态',
              dataIndex: 'enabled',
              render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? '已开启' : '已关闭'}</Tag>,
            },
            { title: '已配置人数', dataIndex: 'memberCount' },
            { title: '最后更新时间', dataIndex: 'updatedAt', render: (value: string) => new Date(value).toLocaleString() },
            {
              title: '操作',
              render: (_: unknown, row: WhitelistRecord) => (
                <Space>
                  <Button onClick={() => navigate(`/whitelists/${row.surveyId}/edit`)}>编辑</Button>
                  <Popconfirm
                    title="确认删除该白名单？"
                    cancelText="No"
                    onConfirm={async () => {
                      await http.delete(`/admin/whitelists/${row.surveyId}`);
                      message.success('白名单已删除');
                      load();
                    }}
                  >
                    <Button danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

function WhitelistEditorPage() {
  const { surveyId } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const editing = Boolean(surveyId);
  const [step, setStep] = useState(editing ? 1 : 0);
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [existingWhitelists, setExistingWhitelists] = useState<WhitelistRecord[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactKeyword, setContactKeyword] = useState('');
  const [selectedSurveyId, setSelectedSurveyId] = useState<number | undefined>(surveyId ? Number(surveyId) : undefined);
  const [enabled, setEnabled] = useState(true);
  const [activeTab, setActiveTab] = useState('manual');
  const [manualMembers, setManualMembers] = useState<Contact[]>([]);
  const [csvMembers, setCsvMembers] = useState<Contact[]>([]);
  const [csvResult, setCsvResult] = useState<any>();
  const [fileList, setFileList] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([http.get('/admin/surveys'), http.get('/admin/whitelists'), http.get('/admin/contacts')]).then(
      async ([surveyRes, whitelistRes, contactRes]) => {
        setSurveys(surveyRes.data);
        setExistingWhitelists(whitelistRes.data);
        setContacts(contactRes.data);
        if (surveyId) {
          const { data } = await http.get(`/admin/whitelists/${surveyId}`);
          setEnabled(data.enabled);
          setManualMembers(data.members || []);
          setCsvMembers(data.members || []);
        }
      },
    );
  }, [surveyId]);

  const selectedSurvey = surveys.find((item) => item.id === selectedSurveyId);
  const configuredIds = new Set(existingWhitelists.map((item) => item.surveyId));
  const availableSurveys = surveys.filter((survey) => survey.id === selectedSurveyId || !configuredIds.has(survey.id));
  const activeMembers = activeTab === 'manual' ? manualMembers : csvMembers;
  const filteredContacts = contacts.filter((contact) => {
    const keyword = contactKeyword.trim();
    if (!keyword) return true;
    return [contact.name, contact.department, contact.phone].some((value) => String(value || '').includes(keyword));
  });

  function addManualMember(contact: Contact) {
    setManualMembers((prev) => (prev.some((item) => item.id === contact.id) ? prev : [...prev, contact]));
  }

  function removeManualMember(contactId: number) {
    setManualMembers((prev) => prev.filter((item) => item.id !== contactId));
  }

  function downloadWhitelistTemplate() {
    const csv = '张三,13800000001\n李四,13800000002\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'whitelist_template.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function parseWhitelistCsv(file: File) {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: async (result) => {
        if (result.errors.length > 0) {
          message.error('CSV 解析失败，请检查文件格式');
          return;
        }
        const rawRows = (result.data as any[][]).filter((row) => row.some((cell) => String(cell || '').trim()));
        if (rawRows.length > 1000) {
          message.error('文件行数超过 1000 行，请拆分后分批导入');
          return;
        }
        const rows = rawRows.map((row) => ({ name: String(row[0] || '').trim(), phone: String(row[1] || '').trim() }));
        const invalid = rows.filter((row) => !/^1\d{10}$/.test(row.phone)).map((row) => ({ ...row, reason: '手机号格式错误' }));
        const validRows = rows.filter((row) => /^1\d{10}$/.test(row.phone));
        const { data } = await http.post('/admin/whitelists/match-csv', { rows: validRows });
        const matchedContacts = data.matched.map((item: any) => ({
          id: item.contactId,
          name: item.name,
          phone: item.phone,
          department: item.department,
        }));
        setCsvMembers(matchedContacts);
        setCsvResult({ total: rows.length, matched: data.matched, unmatched: [...invalid, ...data.unmatched] });
      },
      error: () => message.error('CSV 读取失败，请重新选择文件'),
    });
  }

  async function saveWhitelist() {
    if (!selectedSurveyId) {
      message.error('请先选择问卷');
      return;
    }
    setSaving(true);
    try {
      const payload = { surveyId: selectedSurveyId, enabled, memberContactIds: activeMembers.map((item) => item.id) };
      if (editing) {
        await http.put(`/admin/whitelists/${selectedSurveyId}`, payload);
      } else {
        await http.post('/admin/whitelists', payload);
      }
      message.success('白名单已保存');
      navigate('/whitelists');
    } catch (error: any) {
      message.error(error.response?.data?.message || '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">{editing ? '编辑白名单' : '新增白名单'}</h1>
        <Button onClick={() => navigate('/whitelists')}>返回列表</Button>
      </div>
      <Card className="whitelist-editor">
        <Steps current={step} items={[{ title: '选择问卷' }, { title: '配置人员' }]} style={{ marginBottom: 24 }} />
        {step === 0 ? (
          <>
            <div className="whitelist-survey-grid">
              {availableSurveys.map((survey) => (
                <button
                  key={survey.id}
                  type="button"
                  className={`whitelist-survey-card ${selectedSurveyId === survey.id ? 'selected' : ''}`}
                  onClick={() => setSelectedSurveyId(survey.id)}
                >
                  <div className="whitelist-survey-title">{survey.title}</div>
                  <Space>
                    <Tag color={surveyTypeColor(survey.type)}>{surveyTypeLabel(survey.type)}</Tag>
                    <Tag>尚未配置白名单</Tag>
                  </Space>
                </button>
              ))}
            </div>
            {availableSurveys.length === 0 && <Empty description="暂无可配置白名单的问卷" />}
            <div className="whitelist-footer">
              <Button onClick={() => navigate('/whitelists')}>取消</Button>
              <Button type="primary" disabled={!selectedSurveyId} onClick={() => setStep(1)}>
                下一步
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="whitelist-survey-info">
              <div>
                <div className="whitelist-survey-title">{selectedSurvey?.title || '-'}</div>
                {selectedSurvey && <Tag color={surveyTypeColor(selectedSurvey.type)}>{surveyTypeLabel(selectedSurvey.type)}</Tag>}
              </div>
              <Switch checked={enabled} onChange={setEnabled} checkedChildren="已开启" unCheckedChildren="已关闭" />
            </div>
            {enabled ? (
              <Alert type="warning" showIcon message="白名单已开启：仅下方名单内的用户可填写该问卷，名单外用户将看到“该问卷暂未开放”。" style={{ marginBottom: 16 }} />
            ) : (
              <Alert type="info" showIcon message="白名单已关闭，所有通过企微授权的用户均可填写。" style={{ marginBottom: 16 }} />
            )}
            <Typography.Paragraph type="secondary">保存时将以当前 Tab 的人员列表为准。</Typography.Paragraph>
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
              items={[
                {
                  key: 'manual',
                  label: '手动选择',
                  children: (
                    <div className="whitelist-columns">
                      <div className="whitelist-column">
                        <Input.Search placeholder="按姓名、部门或手机号搜索" allowClear value={contactKeyword} onChange={(event) => setContactKeyword(event.target.value)} />
                        <div className="whitelist-contact-list">
                          {filteredContacts.map((contact) => {
                            const added = manualMembers.some((item) => item.id === contact.id);
                            return (
                              <div key={contact.id} className="whitelist-person-row">
                                <AvatarName name={contact.name} active={added} />
                                <div className="whitelist-person-main">
                                  <div>{contact.name}</div>
                                  <Typography.Text type="secondary">{contact.department || '-'}</Typography.Text>
                                </div>
                                {added ? <Tag color="green">已添加</Tag> : <Button shape="circle" icon={<PlusOutlined />} onClick={() => addManualMember(contact)} />}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <WhitelistMemberPanel members={manualMembers} onClear={() => setManualMembers([])} onRemove={removeManualMember} />
                    </div>
                  ),
                },
                {
                  key: 'csv',
                  label: '批量导入 CSV',
                  children: (
                    <div className="whitelist-csv">
                      {!csvResult ? (
                        <>
                          <Typography.Paragraph>CSV 文件格式：两列，无需表头。第一列姓名，第二列手机号，以手机号匹配联系人。</Typography.Paragraph>
                          <Upload.Dragger
                            accept=".csv,text/csv"
                            maxCount={1}
                            fileList={fileList}
                            beforeUpload={(file) => {
                              if (!file.name.toLowerCase().endsWith('.csv')) {
                                message.error('仅支持 CSV 文件');
                                return Upload.LIST_IGNORE;
                              }
                              setFileList([file]);
                              parseWhitelistCsv(file as File);
                              return false;
                            }}
                            onRemove={() => {
                              setFileList([]);
                              setCsvResult(undefined);
                              setCsvMembers([]);
                            }}
                          >
                            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                            <p className="ant-upload-text">点击或拖拽 CSV 文件到此处上传</p>
                            <p className="ant-upload-hint">最多 1000 行，仅匹配已存在联系人</p>
                          </Upload.Dragger>
                          <Button type="link" className="contact-template-link" onClick={downloadWhitelistTemplate}>
                            下载 CSV 模板
                          </Button>
                        </>
                      ) : (
                        <>
                          <div className="whitelist-import-stats">
                            <Card size="small"><strong>{csvResult.total}</strong><span>共导入行数</span></Card>
                            <Card size="small"><strong className="success">{csvResult.matched.length}</strong><span>匹配成功</span></Card>
                            <Card size="small"><strong className="danger">{csvResult.unmatched.length}</strong><span>匹配失败</span></Card>
                          </div>
                          {csvResult.unmatched.length > 0 && (
                            <div className="whitelist-fail-list">
                              <Typography.Text type="danger">以下人员未匹配成功，不会加入白名单。</Typography.Text>
                              {csvResult.unmatched.map((item: any, index: number) => (
                                <div key={`${item.phone}-${index}`} className="whitelist-fail-row">
                                  <span>{item.name || '-'}</span>
                                  <span>{item.phone || '-'}</span>
                                  <Tag color="red">{item.reason}</Tag>
                                </div>
                              ))}
                            </div>
                          )}
                          <WhitelistMemberPanel members={csvMembers} onClear={() => setCsvMembers([])} onRemove={(id) => setCsvMembers((prev) => prev.filter((item) => item.id !== id))} />
                          <Button onClick={() => { setCsvResult(undefined); setFileList([]); setCsvMembers([]); }}>重新上传</Button>
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
            />
            <div className="whitelist-footer">
              {!editing && <Button onClick={() => setStep(0)}>上一步</Button>}
              <Button type="primary" loading={saving} onClick={saveWhitelist}>
                保存白名单
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function AvatarName({ name, active }: { name: string; active?: boolean }) {
  return <div className={`whitelist-avatar ${active ? 'active' : ''}`}>{(name || '?').slice(0, 1)}</div>;
}

function WhitelistMemberPanel({ members, onClear, onRemove }: { members: Contact[]; onClear: () => void; onRemove: (id: number) => void }) {
  return (
    <div className="whitelist-column">
      <div className="whitelist-member-head">
        <strong>已添加 {members.length} 人</strong>
        <Popconfirm title="确认清空全部成员？" cancelText="No" onConfirm={onClear}>
          <Button size="small">清空</Button>
        </Popconfirm>
      </div>
      <div className="whitelist-contact-list">
        {members.length === 0 ? (
          <Empty description="从左侧选择联系人添加到白名单" />
        ) : (
          members.map((contact) => (
            <div key={contact.id} className="whitelist-person-row">
              <AvatarName name={contact.name} active />
              <div className="whitelist-person-main">
                <div>{contact.name}</div>
                <Typography.Text type="secondary">{contact.department || '-'}</Typography.Text>
              </div>
              <Button type="text" danger onClick={() => onRemove(contact.id)}>
                ×
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ContactsPage() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState<File>();
  const [importFileList, setImportFileList] = useState<any[]>([]);
  const [form] = Form.useForm();
  const load = async () => setRows((await http.get('/admin/contacts')).data);

  useEffect(() => {
    load();
  }, []);

  function resetImportModal() {
    setImportFile(undefined);
    setImportFileList([]);
    setImporting(false);
  }

  function downloadContactTemplate() {
    const csv = [
      ['姓名', '部门', '工号', '职位', '手机号', '邮箱', '标签'],
      ['张三', '人事部/招聘组', 'HR001', '招聘专员', '13800000001', 'zhangsan@example.com', '总部,人事'],
      ['李四', '运营部/华东组', 'OP002', '运营主管', '13800000002', 'lisi@example.com', '一线,运营'],
    ]
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '联系人导入模板.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function importContactsFromCsv() {
    if (!importFile) {
      message.error('请先选择 CSV 文件');
      return;
    }

    setImporting(true);
    Papa.parse(importFile, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          if (result.errors.length > 0) {
            message.error('CSV 解析失败，请检查模板格式');
            return;
          }
          const dataRows = (result.data as any[]).filter((row) => row && Object.values(row).some((value) => String(value || '').trim()));
          const invalidRows = dataRows.filter((row) => !String(row.name || row['姓名'] || '').trim() || !String(row.phone || row['手机号'] || '').trim());
          if (invalidRows.length > 0) {
            message.error(`导入失败：有 ${invalidRows.length} 行缺少姓名或手机号，请补全后重新上传`);
            return;
          }
          const { data } = await http.post('/admin/contacts/import', { rows: dataRows });
          message.success(`导入完成，共导入 ${data.count} 条${data.skipped ? `，跳过 ${data.skipped} 条` : ''}`);
          setImportOpen(false);
          resetImportModal();
          load();
        } catch (error: any) {
          message.error(error.response?.data?.message || '导入失败，请稍后重试');
        } finally {
          setImporting(false);
        }
      },
      error: () => {
        message.error('CSV 读取失败，请重新选择文件');
        setImporting(false);
      },
    });
  }

  return (
    <Card
      title="联系人"
      extra={
        <Space>
          <Button icon={<DownloadOutlined />} onClick={() => downloadFile('/admin/contacts/export', 'contacts.csv')}>
            导出
          </Button>
          <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
            导入 CSV
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing({});
              form.resetFields();
            }}
          >
            新增
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        dataSource={rows}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '部门', dataIndex: 'department' },
          { title: '工号', dataIndex: 'jobNo' },
          { title: '手机号', dataIndex: 'phone' },
          { title: '邮箱', dataIndex: 'email' },
          {
            title: '操作',
            render: (_: unknown, row: any) => (
              <Space>
                <Button
                  onClick={() => {
                    setEditing(row);
                    form.setFieldsValue(row);
                  }}
                >
                  编辑
                </Button>
                <Popconfirm title="确认删除？" cancelText="No" onConfirm={async () => { await http.delete(`/admin/contacts/${row.id}`); load(); }}>
                  <Button danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal open={Boolean(editing)} title="联系人" onCancel={() => setEditing(undefined)} onOk={() => form.submit()} okText="保存" cancelText="取消">
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            if (editing.id) {
              await http.put(`/admin/contacts/${editing.id}`, values);
            } else {
              await http.post('/admin/contacts', values);
            }
            setEditing(undefined);
            load();
          }}
        >
          {['name', 'department', 'jobNo', 'position', 'phone', 'email', 'tags'].map((name) => (
            <Form.Item
              key={name}
              name={name}
              label={fieldLabel(name)}
              rules={
                name === 'name'
                  ? [{ required: true, message: '请输入姓名' }]
                  : name === 'phone'
                    ? [{ required: true, message: '请输入手机号，后续将用于匹配企微身份' }]
                    : []
              }
            >
              <Input />
            </Form.Item>
          ))}
        </Form>
      </Modal>

      <Modal
        title="批量导入联系人"
        open={importOpen}
        okText="确定上传"
        cancelText="取消"
        okButtonProps={{ disabled: !importFile, loading: importing }}
        onOk={importContactsFromCsv}
        onCancel={() => {
          setImportOpen(false);
          resetImportModal();
        }}
      >
        <Upload.Dragger
          accept=".csv,text/csv"
          maxCount={1}
          fileList={importFileList}
          beforeUpload={(file) => {
            const isCsv = file.name.toLowerCase().endsWith('.csv');
            if (!isCsv) {
              message.error('仅支持导入 CSV 文件，请下载模板后重新上传');
              setImportFile(undefined);
              setImportFileList([]);
              return Upload.LIST_IGNORE;
            }
            setImportFile(file as File);
            setImportFileList([file]);
            return false;
          }}
          onRemove={() => {
            setImportFile(undefined);
            setImportFileList([]);
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽 CSV 文件到此处上传</p>
          <p className="ant-upload-hint">最大支持 10000 条记录</p>
        </Upload.Dragger>
        <Typography.Paragraph className="contact-import-warning">*请按模板填写联系人信息，姓名和手机号为必填字段，手机号后续用于匹配企微身份，编码格式要求 UTF-8</Typography.Paragraph>
        <Button type="link" className="contact-template-link" onClick={downloadContactTemplate}>
          下载导入模板
        </Button>
      </Modal>
    </Card>
  );
}

function MembersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = async () => setRows((await http.get('/admin/members')).data);

  useEffect(() => {
    load();
  }, []);

  return (
    <Card title="后台成员" extra={<Button type="primary" onClick={() => setOpen(true)}>新增成员</Button>}>
      <Table
        rowKey="id"
        dataSource={rows}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '手机号', dataIndex: 'phone' },
          { title: '主账号', dataIndex: 'isPrimary', render: (value: boolean) => (value ? <Tag color="gold">主账号</Tag> : '-') },
          { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => new Date(value).toLocaleString() },
          {
            title: '操作',
            render: (_: unknown, row: any) =>
              row.isPrimary ? (
                <Button disabled>删除</Button>
              ) : (
                <Popconfirm title="确认删除？" cancelText="No" onConfirm={async () => { await http.delete(`/admin/members/${row.id}`); load(); }}>
                  <Button danger>删除</Button>
                </Popconfirm>
              ),
          },
        ]}
      />

      <Modal open={open} title="新增成员" onCancel={() => setOpen(false)} onOk={() => form.submit()} okText="保存" cancelText="取消">
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            await http.post('/admin/members', values);
            setOpen(false);
            form.resetFields();
            load();
          }}
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="登录密码" rules={[{ required: true, message: '请输入登录密码' }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function FillPage() {
  const { shareToken } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [survey, setSurvey] = useState<any>();
  const [error, setError] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [submitting, setSubmitting] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    // 1. 从 URL 提取 fill_token / auth_error（OAuth 回调带回来的）
    const params = new URLSearchParams(window.location.search);
    const newToken = params.get('fill_token');
    const authError = params.get('auth_error');

    if (newToken) {
      localStorage.setItem('fill_token', newToken);
      // 清除 URL 中的 token 参数
      params.delete('fill_token');
      const clean = params.toString() ? `?${params.toString()}` : '';
      window.history.replaceState({}, '', `${window.location.pathname}${clean}`);
    }

    if (authError) {
      setError(decodeURIComponent(authError));
      setAuthChecking(false);
      return;
    }

    // 2. 检查 fill_token
    const token = localStorage.getItem('fill_token');
    if (!token) {
      // 无 token → 跳转企微授权
      window.location.href = `${API.replace('/api', '')}/api/wecom/oauth/url?state=/s/${shareToken}`;
      return;
    }

    // 3. 加载问卷
    setAuthChecking(false);
    fillHttp
      .get(`/survey/${shareToken}`)
      .then(({ data }) => setSurvey(data))
      .catch((err) => {
        if (err.response?.status === 401) {
          // token 过期，清除后重新授权
          localStorage.removeItem('fill_token');
          window.location.href = `${API.replace('/api', '')}/api/wecom/oauth/url?state=/s/${shareToken}`;
        } else {
          setError(err.response?.data?.message || '问卷不存在或已下线');
        }
      });
  }, [shareToken]);

  const visibleQuestions = useMemo(
    () => (survey?.schemaJson?.questions || []).filter((question: Question) => isVisible(question, answers)),
    [survey, answers],
  );

  if (authChecking) return <div className="fill-page"><Card loading style={{ margin: 'auto', marginTop: 80, maxWidth: 400 }} /></div>;
  if (error) return <Result status="warning" title={error} />;
  if (!survey) return <div className="fill-page"><Card loading /></div>;

  if (survey.type === 'promotional_document') {
    return (
      <div className="fill-page">
        <div className="fill-panel">
          <Typography.Title level={3}>{survey.title}</Typography.Title>
          <div className="rich-preview-body" dangerouslySetInnerHTML={{ __html: survey.schemaJson?.contentHtml || '' }} />
        </div>
      </div>
    );
  }

  async function submit() {
    if (submitting) return;

    setSubmitting(true);
    try {
      await fillHttp.post(`/survey/${shareToken}/submit`, { answers });
      navigate('/success');
    } catch (err: any) {
      message.error(err.response?.data?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  const answerableQuestions = visibleQuestions.filter((q: Question) => q.type !== 'description');
  const answeredCount = answerableQuestions.filter((q: Question) => {
    const val = answers[q.id];
    if (Array.isArray(val)) return val.length > 0;
    return val !== undefined && val !== '';
  }).length;
  const totalCount = answerableQuestions.length;
  const progressPct = totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) : 0;

  return (
    <div className="fill-page">
      {/* 渐变大头图 Banner */}
      <div className="fill-banner">
        <div className="fill-banner-tag">{
          { assessment: '问卷考核', case_collection: '案例收集', promotional_document: '宣传文档' }[survey.type as string] || '问卷'
        }</div>
        <div className="fill-banner-title">{survey.title}</div>
        {survey.currentUser?.name && (
          <div className="fill-banner-user">填写人：{survey.currentUser.name}</div>
        )}
      </div>

      <div className="fill-body">
        {/* 悬浮进度卡片 */}
        <div className="fill-progress-card">
          <div className="fill-progress-text">
            <span>已完成 <strong>{answeredCount}</strong> / 共 <strong>{totalCount}</strong> 题</span>
            <span className="fill-progress-pct">{progressPct}%</span>
          </div>
          <div className="fill-progress-bar-bg">
            <div className="fill-progress-bar-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        {/* 题目列表 */}
        <Form layout="vertical" onFinish={submit}>
          {visibleQuestions.map((question: Question, index: number) => {
            const questionNo = String(index + 1).padStart(2, '0');
            const isAnswered = question.type !== 'description' && (() => {
              const val = answers[question.id];
              if (Array.isArray(val)) return val.length > 0;
              return val !== undefined && val !== '';
            })();

            if (question.type === 'description') {
              return (
                <div key={question.id} className="fill-question-card fill-description-block">
                  <div className="fill-question-heading">
                    <span className="fill-question-index">{questionNo}</span>
                    <span className="fill-question-title">{question.description || question.label}</span>
                  </div>
                </div>
              );
            }

            return (
              <div key={question.id} className={`fill-question-card${isAnswered ? ' answered' : ''}`}>
                <div className="fill-question-heading">
                  {question.required && <span className="fill-required-mark">*</span>}
                  <span className="fill-question-index">{questionNo}</span>
                  <span className="fill-question-title">{question.label}</span>
                </div>
                {question.description && <Typography.Paragraph className="fill-question-description">{question.description}</Typography.Paragraph>}
                <QuestionInput question={question} value={answers[question.id]} onChange={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))} />
              </div>
            );
          })}
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={submitting}
            disabled={submitting}
            className="fill-submit-btn"
          >
            提交问卷
          </Button>
        </Form>
      </div>
    </div>
  );
}

function QuestionInput({ question, value, onChange }: { question: Question; value: any; onChange: (value: any) => void }) {
  if (question.type === 'radio') {
    return (
      <div className="fill-choice-group">
        {(question.options || []).map((item) => (
          <button
            key={item}
            type="button"
            className={`fill-choice-row ${value === item ? 'selected' : ''}`}
            onClick={() => onChange(item)}
          >
            <span className="choice-symbol" />
            <span className="fill-choice-label">{item}</span>
          </button>
        ))}
      </div>
    );
  }
  if (question.type === 'checkbox') {
    const currentValues = Array.isArray(value) ? value : [];
    return (
      <div className="fill-choice-group">
        {(question.options || []).map((item) => {
          const checked = currentValues.includes(item);
          return (
            <button
              key={item}
              type="button"
              className={`fill-choice-row ${checked ? 'selected' : ''}`}
              onClick={() => onChange(checked ? currentValues.filter((entry) => entry !== item) : [...currentValues, item])}
            >
              <span className="choice-symbol checkbox-symbol" />
              <span className="fill-choice-label">{item}</span>
            </button>
          );
        })}
      </div>
    );
  }
  if (question.type === 'rating') {
    return (
      <div className="rating-input">
        <div className="rating-labels">
          <span>非常不满意</span>
          <span>非常满意</span>
        </div>
        <div className="rating-scale">
          {Array.from({ length: question.maxScore || 10 }, (_, score) => {
            const current = score + 1;
            return (
              <button key={current} type="button" className={`rating-score ${value === current ? 'selected' : ''}`} onClick={() => onChange(current)}>
                {current}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (question.type === 'text') {
    return <AutoResizeTextArea value={value} placeholder="请输入" onChange={onChange} />;
  }
  if (question.type === 'textarea') {
    return <AutoResizeTextArea value={value} placeholder="请输入" onChange={onChange} />;
  }
  if (question.type === 'date' || question.type === 'datetime') {
    return <input className="native-date" type={question.type === 'datetime' ? 'datetime-local' : 'date'} value={value || ''} onChange={(event) => onChange(event.target.value)} />;
  }
  if (question.type === 'file') {
    const props: UploadProps = {
      maxCount: 1,
      action: `${API}/uploads`,
      headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      onChange(info) {
        const url = info.file.response?.url;
        if (url) onChange(`${FILE_BASE}${url}`);
      },
    };
    return (
      <Upload {...props}>
        <Button icon={<UploadOutlined />}>上传文件</Button>
      </Upload>
    );
  }
  return <Input value={value} onChange={(event) => onChange(event.target.value)} />;
}

function autoResizeTextArea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.max(44, element.scrollHeight)}px`;
}

function AutoResizeTextArea({ value, placeholder, onChange }: { value: any; placeholder: string; onChange: (value: string) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    autoResizeTextArea(textareaRef.current);
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      className="auto-resize"
      value={value || ''}
      placeholder={placeholder}
      onInput={(event) => autoResizeTextArea(event.currentTarget)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function isVisible(question: Question, answers: Record<string, any>) {
  if (!question.visibleWhen) return true;
  const parent = answers[question.visibleWhen.questionId];
  if (Array.isArray(parent)) {
    return parent.some((item) => question.visibleWhen?.valueIn.includes(String(item)));
  }
  return question.visibleWhen.valueIn.includes(String(parent));
}

function surveyTypeLabel(type: SurveyKind) {
  return {
    assessment: '问卷考核',
    case_collection: '案例收集',
    promotional_document: '宣传文档类',
  }[type];
}

function surveyTypeColor(type: SurveyKind) {
  return {
    assessment: 'blue',
    case_collection: 'green',
    promotional_document: 'orange',
  }[type];
}

function typeLabel(type: QuestionType) {
  return {
    radio: '单选题',
    checkbox: '多选题',
    rating: '评分打分',
    description: '文本描述',
    text: '单行文本',
    textarea: '多行文本',
    file: '附件上传',
    date: '日期',
    datetime: '日期时间',
  }[type];
}

function fieldLabel(name: string) {
  return {
    name: '姓名',
    department: '部门',
    jobNo: '工号',
    position: '职位',
    phone: '手机号',
    email: '邮箱',
    tags: '标签',
  }[name] || name;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}

export default App;
