import { OrganizationWorkbookService } from './organization-workbook.service';

describe('OrganizationWorkbookService preview', () => {
  const now = new Date('2026-09-02T00:00:00.000Z');
  const departments = [
    {
      id: 1,
      code: 'D1',
      name: '运营组',
      parentId: null,
      sortOrder: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const contacts = [
    {
      id: 10,
      name: '张三',
      department: '运营组',
      jobNo: 'A001',
      position: '专员',
      phone: '13800000001',
      email: null,
      tags: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      memberships: [
        {
          id: 1,
          contactId: 10,
          departmentId: 1,
          isPrimary: true,
          defaultEvalEnabled: true,
          roleName: null,
          createdAt: now,
          updatedAt: now,
          department: departments[0],
        },
      ],
    },
    {
      id: 11,
      name: '李四',
      department: '运营组',
      jobNo: 'A002',
      position: '专员',
      phone: '13800000002',
      email: null,
      tags: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      memberships: [],
    },
  ];

  function createService() {
    const prisma = {
      orgDepartment: { findMany: jest.fn().mockResolvedValue(departments) },
      contact: {
        findMany: jest.fn().mockImplementation((args) => {
          if (args?.select) return Promise.resolve(contacts.map(({ phone }) => ({ phone })));
          return Promise.resolve(contacts);
        }),
      },
    };
    return new OrganizationWorkbookService(prisma as never);
  }

  it('classifies creates, field changes, transfers and inactive candidates', async () => {
    const service = createService();
    const preview = await (service as any).buildPreview(
      {
        departments: [
          { row: 2, code: 'D1', name: '运营部', parentCode: null, sortOrder: 0, isActive: true },
          { row: 3, code: 'D2', name: '门店管理部', parentCode: 'D1', sortOrder: 0, isActive: true },
        ],
        employees: [
          {
            row: 2,
            name: '张三',
            phone: '13800000001',
            jobNo: 'A001',
            position: '主管',
            email: null,
            tags: null,
            primaryDepartmentCode: 'D2',
            primaryRoleName: '负责人',
            isActive: true,
          },
        ],
        secondaries: [],
      },
      'file-hash',
    );

    expect(preview.summary).toMatchObject({ create: 1, change: 2, inactive: 1, conflict: 0 });
    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'department:create:D2', category: 'create' }),
        expect.objectContaining({ id: 'department:change:D1', category: 'change' }),
        expect.objectContaining({ id: 'contact:change:10', changeType: '调岗' }),
        expect.objectContaining({ id: 'contact:inactive:11', category: 'inactive' }),
      ]),
    );
    const transfer = preview.items.find((item: any) => item.id === 'contact:change:10');
    expect(transfer.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '职位', before: '专员', after: '主管' }),
        expect.objectContaining({ label: '主部门', before: 'D1', after: 'D2' }),
      ]),
    );
  });

  it('marks ambiguous phone matches as conflicts instead of updates', () => {
    const service = createService();
    expect((service as any).identityConflict([{ id: 1 }, { id: 2 }], [])).toContain('手机号');
    expect((service as any).identityConflict([{ id: 1 }], [{ id: 2 }])).toContain('不是同一人');
  });
});
