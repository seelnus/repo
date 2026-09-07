import {
  ApartmentOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FullscreenOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  TreeSelect,
  Typography,
  Upload,
} from 'antd';
import Papa from 'papaparse';
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadFile, http } from './App';

type DepartmentNode = {
  id: number;
  code: string;
  name: string;
  parentId: number | null;
  sortOrder: number;
  isActive: boolean;
  path: string;
  isLeaf: boolean;
  directMemberCount: number;
  totalMemberCount: number;
  children: DepartmentNode[];
};

type Membership = {
  id?: number;
  departmentId: number;
  isPrimary: boolean;
  defaultEvalEnabled: boolean;
  roleName?: string | null;
  departmentPath: string;
  departmentActive: boolean;
};

type ContactRow = {
  id: number;
  name: string;
  department?: string | null;
  primaryDepartmentPath?: string | null;
  jobNo?: string | null;
  position?: string | null;
  phone: string;
  email?: string | null;
  tags?: string | null;
  isActive: boolean;
  identityConflict: boolean;
  memberships: Membership[];
};

type WorkbookPreview = {
  fileHash: string;
  baselineHash: string;
  summary: {
    totalDepartments: number;
    totalEmployees: number;
    create: number;
    change: number;
    inactive: number;
    conflict: number;
    unchanged: number;
  };
  blockingErrors: Array<{ sheet: string; row: number; message: string }>;
  items: WorkbookDiffItem[];
  applied: boolean;
};

type WorkbookDiffItem = {
  id: string;
  category: 'create' | 'change' | 'inactive' | 'conflict' | 'unchanged';
  entityType: 'department' | 'contact';
  changeType: string;
  label: string;
  identity: string;
  sheet: string;
  row: number;
  fields: Array<{ field: string; label: string; before: string; after: string }>;
  reason?: string;
  selectedByDefault: boolean;
};

type CsvPreview = {
  summary: {
    total: number;
    create: number;
    update: number;
    conflict: number;
    skip: number;
  };
  rows: Array<{
    row: number;
    action: 'create' | 'update' | 'conflict' | 'skip';
    name: string;
    phone: string;
    department?: string | null;
    primaryDepartment?: string | null;
    secondaryDepartments?: string[];
    reason?: string;
  }>;
};

type MembershipFormRow = {
  departmentId?: number;
  type: 'primary' | 'secondary';
  roleName?: string;
  defaultEvalEnabled?: boolean;
};

function flattenDepartments(nodes: DepartmentNode[]): DepartmentNode[] {
  return nodes.flatMap((node) => [node, ...flattenDepartments(node.children || [])]);
}

function departmentTreeData(
  nodes: DepartmentNode[],
  leavesOnly = false,
): Array<Record<string, unknown>> {
  return nodes.map((node) => ({
    key: String(node.id),
    value: node.id,
    title: `${node.name}${node.isActive ? '' : '（已停用）'}`,
    disabled: !node.isActive || (leavesOnly && !node.isLeaf),
    children: departmentTreeData(node.children || [], leavesOnly),
  }));
}

function csvTemplate() {
  return [
    ['姓名', '部门', '工号', '职位', '手机号', '邮箱', '标签', '状态'],
    ['张三', '运营部/用户运营部;运营部/公共组;品牌部/品宣组', 'OP001', '运营专员', '13800000001', '', '', '启用'],
  ]
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function downloadText(content: string, fileName: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function OrganizationContactsPage() {
  const { message } = AntApp.useApp();
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [identityConflictCount, setIdentityConflictCount] = useState(0);
  const [organizationContactCount, setOrganizationContactCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<number>();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [membershipType, setMembershipType] = useState<'all' | 'primary' | 'secondary'>('all');
  const [viewMode, setViewMode] = useState<'organization' | 'contacts'>('organization');
  const [departmentDetailOpen, setDepartmentDetailOpen] = useState(false);
  const [organizationZoom, setOrganizationZoom] = useState(1);
  const organizationCanvasRef = useRef<HTMLDivElement>(null);

  const [departmentModalOpen, setDepartmentModalOpen] = useState(false);
  const [editingDepartment, setEditingDepartment] = useState<DepartmentNode>();
  const [departmentForm] = Form.useForm();

  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactRow>();
  const [contactForm] = Form.useForm();
  const watchedMemberships = Form.useWatch<MembershipFormRow[]>('memberships', contactForm) || [];

  const [workbookOpen, setWorkbookOpen] = useState(false);
  const [workbookFile, setWorkbookFile] = useState<File>();
  const [workbookPreview, setWorkbookPreview] = useState<WorkbookPreview>();
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const [workbookCategory, setWorkbookCategory] = useState<'change' | 'inactive' | 'conflict' | 'create'>('change');
  const [workbookSelectedIds, setWorkbookSelectedIds] = useState<string[]>([]);

  const [csvOpen, setCsvOpen] = useState(false);
  const [csvFile, setCsvFile] = useState<File>();
  const [csvRows, setCsvRows] = useState<Record<string, unknown>[]>([]);
  const [csvPreview, setCsvPreview] = useState<CsvPreview>();
  const [csvBusy, setCsvBusy] = useState(false);

  const flatDepartments = useMemo(() => flattenDepartments(departments), [departments]);
  const selectedDepartment = flatDepartments.find((row) => row.id === selectedDepartmentId);
  const leafTreeData = useMemo(() => departmentTreeData(departments, true), [departments]);
  const allTreeData = useMemo(() => departmentTreeData(departments, false), [departments]);

  async function loadDepartments() {
    setDepartments((await http.get('/admin/org/departments/tree')).data);
  }

  async function loadIdentityConflictCount() {
    const { data } = await http.get('/admin/contacts', { params: { status: 'all' } });
    const allContacts = data as ContactRow[];
    setIdentityConflictCount(allContacts.filter((row) => row.identityConflict).length);
    setOrganizationContactCount(allContacts.filter((row) => row.isActive).length);
  }

  async function loadContacts() {
    setLoading(true);
    try {
      const { data } = await http.get('/admin/contacts', {
        params: {
          q: keyword.trim() || undefined,
          departmentId: selectedDepartmentId,
          membershipType,
          status,
        },
      });
      setContacts(data);
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await Promise.all([loadDepartments(), loadContacts(), loadIdentityConflictCount()]);
  }

  useEffect(() => {
    Promise.all([loadDepartments(), loadIdentityConflictCount()]);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(loadContacts, 180);
    return () => window.clearTimeout(timer);
  }, [keyword, selectedDepartmentId, membershipType, status]);

  function openCreateDepartment(parentId?: number) {
    setEditingDepartment(undefined);
    departmentForm.resetFields();
    departmentForm.setFieldsValue({ parentId, sortOrder: 0 });
    setDepartmentModalOpen(true);
  }

  function openEditDepartment(department: DepartmentNode) {
    setEditingDepartment(department);
    departmentForm.setFieldsValue({
      name: department.name,
      code: department.code,
      parentId: department.parentId,
      sortOrder: department.sortOrder,
    });
    setDepartmentModalOpen(true);
  }

  async function saveDepartment() {
    const values = await departmentForm.validateFields();
    if (editingDepartment) {
      await http.put(`/admin/org/departments/${editingDepartment.id}`, {
        name: values.name,
        sortOrder: values.sortOrder,
      });
      if ((values.parentId ?? null) !== editingDepartment.parentId) {
        await http.post(`/admin/org/departments/${editingDepartment.id}/move`, {
          parentId: values.parentId ?? null,
        });
      }
      message.success('部门已更新');
    } else {
      await http.post('/admin/org/departments', values);
      message.success('部门已创建');
    }
    setDepartmentModalOpen(false);
    await refresh();
  }

  async function setDepartmentActive(department: DepartmentNode, isActive: boolean) {
    await http.put(`/admin/org/departments/${department.id}/status`, { isActive });
    message.success(isActive ? '部门已启用' : '部门及下级节点已停用');
    await refresh();
  }

  function openCreateContact() {
    setEditingContact(undefined);
    contactForm.resetFields();
    contactForm.setFieldsValue({
      isActive: true,
      memberships: [
        {
          type: 'primary',
          departmentId: selectedDepartment?.isLeaf ? selectedDepartment.id : undefined,
          defaultEvalEnabled: true,
        },
      ],
    });
    setContactDrawerOpen(true);
  }

  function openEditContact(contact: ContactRow) {
    setEditingContact(contact);
    contactForm.setFieldsValue({
      name: contact.name,
      phone: contact.phone,
      jobNo: contact.jobNo,
      position: contact.position,
      email: contact.email,
      tags: contact.tags,
      isActive: contact.isActive,
      memberships: contact.memberships.map((membership) => ({
        departmentId: membership.departmentId,
        type: membership.isPrimary ? 'primary' : 'secondary',
        roleName: membership.roleName,
        defaultEvalEnabled: membership.defaultEvalEnabled,
      })),
    });
    setContactDrawerOpen(true);
  }

  async function saveContact() {
    const values = await contactForm.validateFields();
    const memberships = (values.memberships as MembershipFormRow[]).map((row) => ({
      departmentId: row.departmentId,
      isPrimary: row.type === 'primary',
      defaultEvalEnabled: row.type === 'primary' ? true : Boolean(row.defaultEvalEnabled),
      roleName: row.roleName,
    }));
    const payload = { ...values, memberships };
    if (editingContact) {
      await http.put(`/admin/contacts/${editingContact.id}`, payload);
      message.success('联系人已更新');
    } else {
      await http.post('/admin/contacts', payload);
      message.success('联系人已创建');
    }
    setContactDrawerOpen(false);
    await refresh();
  }

  async function setContactActive(contact: ContactRow, isActive: boolean) {
    await http.put(`/admin/contacts/${contact.id}/status`, { isActive });
    message.success(isActive ? '联系人已启用' : '联系人已停用');
    await refresh();
  }

  async function removeContact(contact: ContactRow) {
    await http.delete(`/admin/contacts/${contact.id}`);
    message.success('联系人已删除');
    await refresh();
  }

  async function previewWorkbook() {
    if (!workbookFile) return message.error('请选择组织架构 Excel');
    setWorkbookBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', workbookFile);
      const preview = (await http.post('/admin/org/import/preview', formData)).data as WorkbookPreview;
      setWorkbookPreview(preview);
      setWorkbookSelectedIds(
        preview.items
          .filter((item) => item.selectedByDefault && (item.category === 'change' || item.category === 'inactive'))
          .map((item) => item.id),
      );
      setWorkbookCategory(preview.summary.change ? 'change' : preview.summary.inactive ? 'inactive' : preview.summary.conflict ? 'conflict' : 'create');
    } finally {
      setWorkbookBusy(false);
    }
  }

  async function applyWorkbook() {
    if (!workbookFile || !workbookPreview || workbookPreview.blockingErrors.length) return;
    setWorkbookBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', workbookFile);
      formData.append('fileHash', workbookPreview.fileHash);
      formData.append('baselineHash', workbookPreview.baselineHash);
      formData.append('selectedIds', JSON.stringify(workbookSelectedIds));
      const { data } = await http.post('/admin/org/import/apply', formData);
      message.success(`同步完成：新增 ${data.created} 条，变更 ${data.changed} 条，停用 ${data.inactivated} 条`);
      setWorkbookOpen(false);
      setWorkbookFile(undefined);
      setWorkbookPreview(undefined);
      setWorkbookSelectedIds([]);
      await refresh();
    } finally {
      setWorkbookBusy(false);
    }
  }

  function selectCsv(file: File) {
    setCsvFile(file);
    setCsvPreview(undefined);
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => setCsvRows(result.data),
      error: () => message.error('CSV 读取失败'),
    });
  }

  async function previewCsv() {
    if (!csvRows.length) return message.error('请选择有效 CSV');
    setCsvBusy(true);
    try {
      setCsvPreview((await http.post('/admin/contacts/import?dryRun=true', { rows: csvRows })).data);
    } finally {
      setCsvBusy(false);
    }
  }

  async function applyCsv() {
    if (!csvPreview || csvPreview.summary.conflict || csvPreview.summary.skip) return;
    setCsvBusy(true);
    try {
      await http.post('/admin/contacts/import?dryRun=false', { rows: csvRows });
      message.success('联系人 CSV 已导入');
      setCsvOpen(false);
      setCsvFile(undefined);
      setCsvRows([]);
      setCsvPreview(undefined);
      await refresh();
    } finally {
      setCsvBusy(false);
    }
  }

  const enabledEvalPaths = watchedMemberships
    .filter((row) => row?.type === 'primary' || row?.defaultEvalEnabled)
    .map((row) => flatDepartments.find((department) => department.id === row.departmentId)?.path)
    .filter(Boolean) as string[];

  const selectedDepartmentChain = useMemo(() => {
    const chain: DepartmentNode[] = [];
    let current = selectedDepartment;
    while (current) {
      chain.unshift(current);
      current = current.parentId
        ? flatDepartments.find((department) => department.id === current?.parentId)
        : undefined;
    }
    return chain;
  }, [selectedDepartment, flatDepartments]);
  const expandedDepartmentIds = useMemo(
    () => new Set(selectedDepartmentChain.map((department) => department.id)),
    [selectedDepartmentChain],
  );
  const organizationTotal = organizationContactCount;

  function selectDepartment(department: DepartmentNode) {
    setSelectedDepartmentId(department.id);
    setDepartmentDetailOpen(true);
  }

  function renderOrganizationLevel(nodes: DepartmentNode[], parent?: DepartmentNode) {
    return (
      <div className={`organization-chart-level${parent ? ' has-parent' : ' is-root-level'}`}>
        {parent && (
          <div className="organization-column-label">
            <strong>{parent.name}</strong>
            <span>下级部门</span>
          </div>
        )}
        <div className={`organization-chart-branches${nodes.length === 1 ? ' is-single' : ''}`}>
          {nodes.map((department) => {
            const expanded = expandedDepartmentIds.has(department.id) && department.children.length > 0;
            const addChildDisabledReason = !department.isActive
              ? '请先启用该部门'
              : department.directMemberCount > 0
                ? '请先将直接员工迁移到末级部门'
                : undefined;
            return (
              <div className="organization-chart-branch" key={department.id}>
                <div className="organization-node-shell">
                  <button
                    type="button"
                    className={`organization-chart-node${selectedDepartmentId === department.id ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}${department.isActive ? '' : ' is-disabled'}`}
                    onClick={() => selectDepartment(department)}
                  >
                    <span className="organization-node-icon"><FolderOpenOutlined /></span>
                    <span className="organization-node-copy">
                      <strong>{department.name}</strong>
                      <small>{department.totalMemberCount} 人{department.children.length ? ` · ${department.children.length} 个下级` : ''}</small>
                    </span>
                    <Badge count={department.children.length || department.directMemberCount} showZero color={department.children.length ? '#e6f4ff' : '#f0f0f0'} />
                  </button>
                  <Tooltip title={addChildDisabledReason || `在“${department.name}”下新建部门`}>
                    <span className="organization-node-add-wrap">
                      <Button
                        className="organization-node-add"
                        type="text"
                        shape="circle"
                        size="small"
                        icon={<PlusOutlined />}
                        aria-label={`在“${department.name}”下新建部门`}
                        disabled={Boolean(addChildDisabledReason)}
                        onClick={(event) => {
                          event.stopPropagation();
                          openCreateDepartment(department.id);
                        }}
                      />
                    </span>
                  </Tooltip>
                </div>
                {expanded && renderOrganizationLevel(department.children, department)}
              </div>
            );
          })}
        </div>
        {!parent && <Button className="organization-root-add" type="dashed" block icon={<PlusOutlined />} onClick={() => openCreateDepartment()}>新增一级部门</Button>}
      </div>
    );
  }

  const workbookVisibleItems = workbookPreview?.items.filter((item) => item.category === workbookCategory) || [];
  const workbookSelectedChanges = workbookPreview?.items.filter(
    (item) => item.category === 'change' && workbookSelectedIds.includes(item.id),
  ).length || 0;
  const workbookSelectedInactive = workbookPreview?.items.filter(
    (item) => item.category === 'inactive' && workbookSelectedIds.includes(item.id),
  ).length || 0;

  function updateWorkbookCategorySelection(keys: Array<string | number | bigint>) {
    if (!workbookPreview) return;
    const categoryIds = new Set(workbookVisibleItems.map((item) => item.id));
    setWorkbookSelectedIds((current) => [
      ...current.filter((id) => !categoryIds.has(id)),
      ...keys.map(String),
    ]);
  }

  return (
    <div className="organization-page">
      <Card
        title={
          <Space>
            <ApartmentOutlined />
            通讯录与组织架构
          </Space>
        }
        extra={
          <Space wrap>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => downloadFile('/admin/org/export', '组织架构与通讯录.xlsx').catch(() => message.error('导出失败'))}
            >
              导出组织 Excel
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => setWorkbookOpen(true)}>
              导入组织 Excel
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => setCsvOpen(true)}>
              导入联系人 CSV
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateContact}>
              新增员工
            </Button>
          </Space>
        }
      >
        <div className="organization-main-toolbar">
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as typeof viewMode)}
            options={[
              { value: 'organization', label: <Space size={6}><ApartmentOutlined />组织架构</Space> },
              { value: 'contacts', label: <Space size={6}><TeamOutlined />员工列表</Space> },
            ]}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索姓名、手机号、工号、职位或部门"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ maxWidth: 380 }}
          />
          <Button type="text" danger icon={<InboxOutlined />} onClick={() => { setViewMode('contacts'); setSelectedDepartmentId(undefined); }}>身份冲突 {identityConflictCount}</Button>
        </div>

        {viewMode === 'organization' ? (
          <div className="organization-canvas" ref={organizationCanvasRef}>
            <div className="organization-canvas-head">
              <div>
                <Typography.Text strong>公司组织架构</Typography.Text>
                <Typography.Text type="secondary">{organizationTotal} 人 · {flatDepartments.length} 个部门</Typography.Text>
              </div>
              <Space.Compact>
                <Button
                  aria-label="缩小组织图"
                  icon={<ZoomOutOutlined />}
                  disabled={organizationZoom <= 0.7}
                  onClick={() => setOrganizationZoom((value) => Math.max(0.7, Number((value - 0.1).toFixed(1))))}
                />
                <Button onClick={() => setOrganizationZoom(1)}>{Math.round(organizationZoom * 100)}%</Button>
                <Button
                  aria-label="放大组织图"
                  icon={<ZoomInOutlined />}
                  disabled={organizationZoom >= 1.3}
                  onClick={() => setOrganizationZoom((value) => Math.min(1.3, Number((value + 0.1).toFixed(1))))}
                />
                <Button
                  aria-label="全屏查看组织图"
                  icon={<FullscreenOutlined />}
                  onClick={() => organizationCanvasRef.current?.requestFullscreen?.()}
                />
              </Space.Compact>
            </div>
            {departments.length ? (
              <div className="organization-chart-scroll" style={{ zoom: organizationZoom }}>
                <div className="organization-chart-tree">
                  <div className="organization-company-node">
                    <span><ApartmentOutlined /></span>
                    <div><strong>公司组织</strong><small>{organizationTotal} 人</small></div>
                  </div>
                  {renderOrganizationLevel(departments)}
                </div>
              </div>
            ) : (
              <Empty description="暂无部门"><Button type="primary" onClick={() => openCreateDepartment()}>创建第一个部门</Button></Empty>
            )}
            <Typography.Text type="secondary" className="organization-canvas-hint">点击部门查看成员和管理操作；多级架构会沿当前分支向右展开</Typography.Text>
          </div>
        ) : (
          <div className="organization-contact-column">
            <div className="organization-contact-toolbar">
              <Space wrap>
                <Select value={membershipType} onChange={setMembershipType} style={{ width: 130 }} options={[{ value: 'all', label: '全部归属' }, { value: 'primary', label: '主部门' }, { value: 'secondary', label: '兼任部门' }]} />
                <Segmented value={status} onChange={(value) => setStatus(value as typeof status)} options={[{ value: 'active', label: '启用' }, { value: 'inactive', label: '停用' }, { value: 'all', label: '全部' }]} />
                {selectedDepartment && <Tag closable onClose={() => setSelectedDepartmentId(undefined)}>{selectedDepartment.path}</Tag>}
              </Space>
            </div>
            <Table<ContactRow>
              rowKey="id" loading={loading} dataSource={contacts}
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 人` }} scroll={{ x: 1000 }}
              columns={[
                { title: '员工', fixed: 'left', width: 160, render: (_, row) => <Space><span className="organization-avatar"><UserOutlined /></span><div><Typography.Text strong>{row.name}</Typography.Text><div><Typography.Text type="secondary">{row.position || '未填写职位'}</Typography.Text></div></div></Space> },
                { title: '主部门', width: 230, render: (_, row) => row.primaryDepartmentPath || row.department || <Tag color="warning">未归属</Tag> },
                { title: '兼任部门', width: 250, render: (_, row) => { const secondaries = row.memberships.filter((membership) => !membership.isPrimary); return secondaries.length ? secondaries.map((membership) => <Tag key={membership.departmentId} color={membership.defaultEvalEnabled ? 'blue' : 'default'}>{membership.departmentPath.split('/').at(-1)}{membership.defaultEvalEnabled ? ' · 参与互评' : ''}</Tag>) : '-'; } },
                { title: '工号', dataIndex: 'jobNo', width: 110, render: (value) => value || '-' },
                { title: '手机号', dataIndex: 'phone', width: 170, render: (value, row) => <Space>{value}{row.identityConflict && <Tag color="error">身份冲突</Tag>}</Space> },
                { title: '状态', width: 90, render: (_, row) => <Tag color={row.isActive ? 'green' : 'default'}>{row.isActive ? '启用' : '停用'}</Tag> },
                { title: '操作', fixed: 'right', width: 190, render: (_, row) => <Space><Button type="link" onClick={() => openEditContact(row)}>编辑</Button><Popconfirm title={row.isActive ? '停用该联系人？' : '启用该联系人？'} onConfirm={() => setContactActive(row, !row.isActive)}><Button type="link">{row.isActive ? '停用' : '启用'}</Button></Popconfirm><Popconfirm title="只有无业务引用的误建联系人可以删除，确认？" onConfirm={() => removeContact(row)}><Button type="link" danger>删除</Button></Popconfirm></Space> },
              ]}
            />
          </div>
        )}
      </Card>

      <Drawer
        title={selectedDepartment ? <Space><span className="organization-node-icon"><FolderOpenOutlined /></span><div><Typography.Text strong>{selectedDepartment.name}</Typography.Text><div><Typography.Text type="secondary">{selectedDepartment.path}</Typography.Text></div></div></Space> : '部门详情'}
        open={departmentDetailOpen && Boolean(selectedDepartment)}
        onClose={() => setDepartmentDetailOpen(false)}
        width={460}
      >
        {selectedDepartment && (
          <>
            <Row gutter={8} className="organization-detail-stats">
              <Col span={8}><Card size="small"><Typography.Title level={4}>{selectedDepartment.directMemberCount}</Typography.Title><Typography.Text type="secondary">直接成员</Typography.Text></Card></Col>
              <Col span={8}><Card size="small"><Typography.Title level={4}>{contacts.filter((row) => row.memberships.some((membership) => membership.departmentId === selectedDepartment.id && !membership.isPrimary)).length}</Typography.Title><Typography.Text type="secondary">兼任成员</Typography.Text></Card></Col>
              <Col span={8}><Card size="small"><Typography.Title level={4}>{selectedDepartment.children.length}</Typography.Title><Typography.Text type="secondary">下级部门</Typography.Text></Card></Col>
            </Row>
            <Space wrap style={{ margin: '16px 0' }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreateContact}>添加员工</Button>
              <Button icon={<PlusOutlined />} onClick={() => openCreateDepartment(selectedDepartment.id)} disabled={selectedDepartment.directMemberCount > 0}>新增下级</Button>
              <Button icon={<EditOutlined />} onClick={() => openEditDepartment(selectedDepartment)}>编辑部门</Button>
            </Space>
            <Divider orientation="left">部门成员</Divider>
            {loading ? <Typography.Text type="secondary">正在加载成员…</Typography.Text> : contacts.length ? contacts.slice(0, 12).map((contact) => {
              const directMembership = contact.memberships.find((membership) => membership.departmentId === selectedDepartment.id);
              return (
                <div className="organization-member-row" key={contact.id}>
                  <span className="organization-avatar"><UserOutlined /></span>
                  <div><Typography.Text strong>{contact.name}</Typography.Text><div><Typography.Text type="secondary">{contact.position || '未填写职位'}{contact.jobNo ? ` · ${contact.jobNo}` : ''}</Typography.Text></div></div>
                  <Tag color={directMembership?.isPrimary ? 'green' : directMembership ? 'orange' : 'default'}>{directMembership?.isPrimary ? '主部门' : directMembership ? '兼任' : '下级部门'}</Tag>
                  <Button type="link" onClick={() => openEditContact(contact)}>编辑</Button>
                </div>
              );
            }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成员" />}
            <Divider />
            <Space>
              <Popconfirm title={selectedDepartment.isActive ? '停用该部门及全部下级？' : '重新启用该部门？'} onConfirm={() => setDepartmentActive(selectedDepartment, !selectedDepartment.isActive)}><Button>{selectedDepartment.isActive ? '停用部门' : '启用部门'}</Button></Popconfirm>
              <Popconfirm title="仅空部门可以删除，确认继续？" onConfirm={() => http.delete(`/admin/org/departments/${selectedDepartment.id}`).then(refresh)}><Button danger icon={<DeleteOutlined />}>删除部门</Button></Popconfirm>
              <Button onClick={() => { setDepartmentDetailOpen(false); setViewMode('contacts'); }}>查看全部员工</Button>
            </Space>
          </>
        )}
      </Drawer>

      <Modal
        title={editingDepartment ? '编辑部门' : '新建部门'}
        open={departmentModalOpen}
        onCancel={() => setDepartmentModalOpen(false)}
        onOk={() => saveDepartment().catch((error) => message.error(error.response?.data?.message || '保存失败'))}
        okText="保存"
      >
        <Form form={departmentForm} layout="vertical">
          {editingDepartment && <Form.Item label="部门编码" name="code"><Input disabled /></Form.Item>}
          <Form.Item label="部门名称" name="name" rules={[{ required: true, message: '请输入部门名称' }]}><Input maxLength={200} /></Form.Item>
          <Form.Item label="上级部门" name="parentId"><TreeSelect allowClear treeDefaultExpandAll treeData={allTreeData} placeholder="无上级部门时留空" /></Form.Item>
          <Form.Item label="同级排序" name="sortOrder"><InputNumber precision={0} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={editingContact ? `编辑员工：${editingContact.name}` : '新增员工'}
        open={contactDrawerOpen}
        onClose={() => setContactDrawerOpen(false)}
        width={820}
        extra={<Button type="primary" onClick={() => saveContact().catch((error) => message.error(error.response?.data?.message || '保存失败'))}>保存</Button>}
      >
        {editingContact?.identityConflict && (
          <Alert type="error" showIcon message="该手机号被多名联系人共用" description="请先为当前员工填写唯一手机号，保存后身份冲突才会解除。" style={{ marginBottom: 16 }} />
        )}
        <Form form={contactForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item label="姓名" name="name" rules={[{ required: true, message: '请输入姓名' }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="手机号" name="phone" rules={[{ required: true, message: '请输入手机号' }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="工号" name="jobNo"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="职位" name="position"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="邮箱" name="email"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="标签" name="tags"><Input placeholder="多个标签可用逗号分隔" /></Form.Item></Col>
            <Col span={12}><Form.Item label="联系人状态" name="isActive" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item></Col>
          </Row>
          <Divider orientation="left">所属部门</Divider>
          <Alert type="info" showIcon message="每人只能有一个主部门；主部门默认参加互评，兼任部门可分别开启。" style={{ marginBottom: 16 }} />
          <Form.List name="memberships" rules={[{ validator: async (_, rows) => {
            if (!rows?.length) throw new Error('请至少设置一个主部门');
            if (rows.filter((row: MembershipFormRow) => row.type === 'primary').length !== 1) throw new Error('必须且只能有一个主部门');
          } }] }>
            {(fields, { add, remove }, { errors }) => (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {fields.map((field, index) => {
                  const row = watchedMemberships[index];
                  const primary = row?.type === 'primary';
                  return (
                    <Card key={field.key} size="small" title={primary ? <Tag color="green">主部门</Tag> : <Tag>兼任部门</Tag>} extra={fields.length > 1 && <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}>
                      <Row gutter={12}>
                        <Col span={5}><Form.Item label="归属类型" name={[field.name, 'type']} rules={[{ required: true }]}><Select options={[{ value: 'primary', label: '主部门' }, { value: 'secondary', label: '兼任部门' }]} /></Form.Item></Col>
                        <Col span={9}><Form.Item label="末级部门" name={[field.name, 'departmentId']} rules={[{ required: true, message: '请选择部门' }]}><TreeSelect treeDefaultExpandAll treeData={leafTreeData} placeholder="选择末级部门" /></Form.Item></Col>
                        <Col span={6}><Form.Item label="组织职责" name={[field.name, 'roleName']}><Input placeholder="负责人/主管/协作" /></Form.Item></Col>
                        <Col span={4}><Form.Item label="参加互评" name={[field.name, 'defaultEvalEnabled']} valuePropName="checked"><Switch disabled={primary} /></Form.Item></Col>
                      </Row>
                    </Card>
                  );
                })}
                <Button block type="dashed" icon={<PlusOutlined />} onClick={() => add({ type: 'secondary', defaultEvalEnabled: false })}>添加兼任部门</Button>
                <Form.ErrorList errors={errors} />
              </Space>
            )}
          </Form.List>
          <Descriptions title="业务摘要" bordered size="small" column={1} style={{ marginTop: 20 }}>
            <Descriptions.Item label="默认参加互评">
              {enabledEvalPaths.length ? enabledEvalPaths.join('、') : '请先选择主部门'}
            </Descriptions.Item>
            <Descriptions.Item label="说明">打开兼任部门的开关后，该员工将在未来 360 批次中与该部门成员双向互评；本阶段不会改变现有 360 任务。</Descriptions.Item>
          </Descriptions>
        </Form>
      </Drawer>

      <Modal
        title="导入预览与确认"
        open={workbookOpen}
        width={1080}
        onCancel={() => setWorkbookOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setWorkbookOpen(false)}>取消</Button>,
          <Button key="preview" loading={workbookBusy} disabled={!workbookFile} onClick={previewWorkbook}>预览差异</Button>,
          <Button key="apply" type="primary" loading={workbookBusy} disabled={!workbookPreview || workbookPreview.blockingErrors.length > 0} onClick={applyWorkbook}>
            {workbookPreview ? `确认同步：新增 ${workbookPreview.summary.create} 条，应用变更 ${workbookSelectedChanges} 条，停用 ${workbookSelectedInactive} 条` : '确认同步'}
          </Button>,
        ]}
      >
        <Alert type="info" showIcon message="这是全量组织同步" description="文件必须包含“部门、员工、兼任部门”三个工作表。新增数据自动通过；资料变更、调岗和停用候选默认全选，可逐条取消。文件中缺失的启用员工和部门会进入停用候选，但不会被删除。" style={{ marginBottom: 16 }} />
        <Upload.Dragger accept=".xlsx" maxCount={1} beforeUpload={(file) => { setWorkbookFile(file as File); setWorkbookPreview(undefined); setWorkbookSelectedIds([]); return false; }} onRemove={() => { setWorkbookFile(undefined); setWorkbookPreview(undefined); setWorkbookSelectedIds([]); }}>
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽组织架构 Excel</p>
        </Upload.Dragger>
        {workbookPreview && (
          <div className="organization-import-review">
            <Row gutter={10} className="organization-import-summary">
              <Col flex="1"><Card size="small"><Typography.Text type="secondary">文件数据</Typography.Text><Typography.Title level={4}>{workbookPreview.summary.totalEmployees} 人</Typography.Title><Typography.Text type="secondary">{workbookPreview.summary.totalDepartments} 个部门</Typography.Text></Card></Col>
              <Col flex="1"><Card size="small"><Typography.Text type="secondary">自动新增</Typography.Text><Typography.Title level={4} type="success">{workbookPreview.summary.create}</Typography.Title><Typography.Text type="secondary">无需确认</Typography.Text></Card></Col>
              <Col flex="1"><Card size="small"><Typography.Text type="secondary">待确认变更</Typography.Text><Typography.Title level={4}>{workbookPreview.summary.change}</Typography.Title><Typography.Text type="secondary">默认全部应用</Typography.Text></Card></Col>
              <Col flex="1"><Card size="small"><Typography.Text type="secondary">停用候选</Typography.Text><Typography.Title level={4} type="warning">{workbookPreview.summary.inactive}</Typography.Title><Typography.Text type="secondary">只停用不删除</Typography.Text></Card></Col>
              <Col flex="1"><Card size="small"><Typography.Text type="secondary">冲突</Typography.Text><Typography.Title level={4} type="danger">{workbookPreview.summary.conflict}</Typography.Title><Typography.Text type="secondary">不会写入</Typography.Text></Card></Col>
            </Row>
            {workbookPreview.summary.create > 0 && <Alert type="success" showIcon message={`${workbookPreview.summary.create} 条新增数据将自动创建，无需逐条确认`} style={{ margin: '12px 0' }} />}
            {workbookPreview.blockingErrors.length > 0 && <Alert type="error" showIcon message="文件存在结构错误，必须修正后重新预览" description={workbookPreview.blockingErrors.map((error) => `${error.sheet}第${error.row}行：${error.message}`).join('；')} style={{ margin: '12px 0' }} />}
            <Segmented
              block
              value={workbookCategory}
              onChange={(value) => setWorkbookCategory(value as typeof workbookCategory)}
              options={[
                { value: 'change', label: `待确认变更 ${workbookPreview.summary.change}` },
                { value: 'inactive', label: `停用候选 ${workbookPreview.summary.inactive}` },
                { value: 'conflict', label: `冲突 ${workbookPreview.summary.conflict}` },
                { value: 'create', label: `自动新增 ${workbookPreview.summary.create}` },
              ]}
            />
            {workbookCategory === 'inactive' && <Alert type="warning" showIcon message="确认后只会停用，不会删除" description="历史问卷、白名单、360 关系和结果继续保留。取消勾选后，该员工或部门保持原状。" style={{ marginTop: 12 }} />}
            {workbookCategory === 'conflict' && <Alert type="error" showIcon message="冲突记录不会写入" description="请根据原因单独处理；其他已确认的安全数据仍可继续同步。" style={{ marginTop: 12 }} />}
            <Table<WorkbookDiffItem>
              size="small"
              rowKey="id"
              dataSource={workbookVisibleItems}
              pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 条` }}
              rowSelection={workbookCategory === 'change' || workbookCategory === 'inactive' ? {
                selectedRowKeys: workbookSelectedIds,
                preserveSelectedRowKeys: true,
                onChange: updateWorkbookCategorySelection,
              } : undefined}
              expandable={{
                rowExpandable: (row) => row.fields.length > 0,
                expandedRowRender: (row) => (
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="field"
                    dataSource={row.fields}
                    columns={[
                      { title: '变更字段', dataIndex: 'label', width: 150 },
                      { title: '变更前', dataIndex: 'before', render: (value) => <span className="organization-diff-before">{value}</span> },
                      { title: '变更后', dataIndex: 'after', render: (value) => <span className="organization-diff-after">{value}</span> },
                    ]}
                  />
                ),
              }}
              columns={[
                { title: '对象', width: 180, render: (_, row) => <div><Typography.Text strong>{row.label}</Typography.Text><div><Typography.Text type="secondary">{row.identity}</Typography.Text></div></div> },
                { title: '类型', dataIndex: 'changeType', width: 120, render: (value, row) => <Tag color={row.category === 'conflict' ? 'red' : row.category === 'inactive' ? 'orange' : row.category === 'create' ? 'green' : 'blue'}>{value}</Tag> },
                { title: '关键变化', render: (_, row) => row.reason || (row.fields.length ? <Space split={<span>→</span>}><span className="organization-diff-before">{row.fields[0].before}</span><span className="organization-diff-after">{row.fields[0].after}</span></Space> : '无字段变化') },
                { title: '来源', width: 110, render: (_, row) => `${row.sheet}${row.row ? ` 第${row.row}行` : ''}` },
              ]}
              style={{ marginTop: 12 }}
            />
          </div>
        )}
      </Modal>

      <Modal
        title="兼容导入联系人 CSV"
        open={csvOpen}
        width={1040}
        onCancel={() => setCsvOpen(false)}
        footer={[
          <Button key="template" onClick={() => downloadText(csvTemplate(), '联系人导入模板.csv')}>下载模板</Button>,
          <Button key="cancel" onClick={() => setCsvOpen(false)}>取消</Button>,
          <Button key="preview" disabled={!csvFile} loading={csvBusy} onClick={previewCsv}>预览</Button>,
          <Button key="apply" type="primary" loading={csvBusy} disabled={!csvPreview || csvPreview.summary.conflict > 0 || csvPreview.summary.skip > 0} onClick={applyCsv}>确认导入</Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          message="CSV 不再按姓名覆盖员工"
          description="系统优先按手机号匹配；手机号重复时会阻止导入。部门层级使用 / 分隔，多个部门使用 ; 或 ；分隔：第一个是主部门，后续是兼任部门并默认参加互评。重新导入时，部门归属以文件内容为准。"
          style={{ marginBottom: 16 }}
        />
        <Upload.Dragger accept=".csv,text/csv" maxCount={1} beforeUpload={(file) => { selectCsv(file as File); return false; }} onRemove={() => { setCsvFile(undefined); setCsvRows([]); setCsvPreview(undefined); }}>
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽联系人 CSV</p>
        </Upload.Dragger>
        {csvPreview && (
          <div style={{ marginTop: 16 }}>
            <Descriptions bordered size="small" column={5}>
              <Descriptions.Item label="总行数">{csvPreview.summary.total}</Descriptions.Item>
              <Descriptions.Item label="新增">{csvPreview.summary.create}</Descriptions.Item>
              <Descriptions.Item label="更新">{csvPreview.summary.update}</Descriptions.Item>
              <Descriptions.Item label="冲突"><Typography.Text type={csvPreview.summary.conflict ? 'danger' : undefined}>{csvPreview.summary.conflict}</Typography.Text></Descriptions.Item>
              <Descriptions.Item label="无效">{csvPreview.summary.skip}</Descriptions.Item>
            </Descriptions>
            <Table
              size="small"
              rowKey="row"
              dataSource={csvPreview.rows}
              pagination={{ pageSize: 8 }}
              scroll={{ x: 980 }}
              columns={[
                { title: '行号', dataIndex: 'row', width: 70 },
                { title: '姓名', dataIndex: 'name', width: 110 },
                { title: '手机号', dataIndex: 'phone', width: 140 },
                { title: '主部门', dataIndex: 'primaryDepartment', width: 220, render: (value) => value || '-' },
                {
                  title: '兼任部门',
                  dataIndex: 'secondaryDepartments',
                  width: 280,
                  render: (values: string[] | undefined) => values?.length
                    ? <Space size={[0, 4]} wrap>{values.map((value) => <Tag color="blue" key={value}>{value}</Tag>)}</Space>
                    : '-',
                },
                { title: '结果', dataIndex: 'action', width: 80, render: (value) => <Tag color={value === 'conflict' || value === 'skip' ? 'red' : value === 'create' ? 'green' : 'blue'}>{({ create: '新增', update: '更新', conflict: '冲突', skip: '无效' } as Record<string, string>)[value]}</Tag> },
                { title: '说明', dataIndex: 'reason', width: 200, render: (value) => value || '-' },
              ]}
              style={{ marginTop: 12 }}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
