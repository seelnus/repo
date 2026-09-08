import { BadRequestException } from '@nestjs/common';
import {
  normalizeContactPhone,
  normalizeMembershipInputs,
  OrganizationService,
  parseContactDepartmentPaths,
  splitDepartmentPath,
} from './organization.service';

describe('organization rules', () => {
  it('normalizes manually entered phone numbers', () => {
    expect(normalizeContactPhone(' 138-0000 0001 ')).toBe('13800000001');
    expect(normalizeContactPhone('(0573) 8888-9999')).toBe('057388889999');
  });

  it('accepts the common department path separators used by spreadsheets', () => {
    expect(splitDepartmentPath('运营部／线下项目组 > 门店管理部')).toEqual([
      '运营部',
      '线下项目组',
      '门店管理部',
    ]);
  });

  it('splits the first CSV department as primary and the rest as secondary', () => {
    expect(
      parseContactDepartmentPaths(
        '闯货/员工私人号/部门负责人及大组长互评; 闯货/员工私人号/杭州投放；闯货/员工私人号/品宣部',
      ),
    ).toEqual({
      paths: [
        ['闯货', '员工私人号', '部门负责人及大组长互评'],
        ['闯货', '员工私人号', '杭州投放'],
        ['闯货', '员工私人号', '品宣部'],
      ],
      duplicatePath: null,
    });
  });

  it('keeps old single-department CSV values compatible and detects duplicate paths', () => {
    expect(parseContactDepartmentPaths('运营部/用户运营部').paths).toEqual([
      ['运营部', '用户运营部'],
    ]);
    expect(
      parseContactDepartmentPaths('运营部/用户运营部;运营部／用户运营部')
        .duplicatePath,
    ).toBe('运营部/用户运营部');
  });

  it('requires exactly one primary department and always enables its evaluation scope', () => {
    expect(
      normalizeMembershipInputs([
        { departmentId: 10, isPrimary: true, defaultEvalEnabled: false },
        { departmentId: 11, isPrimary: false, defaultEvalEnabled: false },
      ]),
    ).toEqual([
      {
        departmentId: 10,
        isPrimary: true,
        defaultEvalEnabled: true,
        roleName: null,
      },
      {
        departmentId: 11,
        isPrimary: false,
        defaultEvalEnabled: false,
        roleName: null,
      },
    ]);
  });

  it.each([
    [[], '请至少设置一个主部门'],
    [[{ departmentId: 1 }], '每名员工必须且只能设置一个主部门'],
    [
      [
        { departmentId: 1, isPrimary: true },
        { departmentId: 2, isPrimary: true },
      ],
      '每名员工必须且只能设置一个主部门',
    ],
    [
      [
        { departmentId: 1, isPrimary: true },
        { departmentId: 1, isPrimary: false },
      ],
      '同一部门不能重复添加',
    ],
  ])('rejects invalid membership combinations', (memberships, expected) => {
    expect(() => normalizeMembershipInputs(memberships)).toThrow(
      new BadRequestException(expected),
    );
  });
});

describe('contact CSV multi-department import', () => {
  function createImportHarness() {
    const departments: any[] = [];
    const contactUpdate = jest.fn(async ({ data }) => ({ id: 42, ...data }));
    const membershipDeleteMany = jest.fn(async () => ({ count: 2 }));
    const membershipCreateMany = jest.fn(async ({ data }) => ({
      count: data.length,
    }));
    const tx = {
      orgDepartment: {
        findFirst: jest.fn(
          async ({ where }) =>
            departments.find(
              (department) =>
                department.parentId === where.parentId &&
                department.name === where.name,
            ) || null,
        ),
        upsert: jest.fn(async ({ create }) => {
          const department = {
            id: departments.length + 1,
            ...create,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          departments.push(department);
          return department;
        }),
        findMany: jest.fn(async () => departments),
      },
      contact: {
        update: contactUpdate,
        create: jest.fn(async ({ data }) => ({ id: 42, ...data })),
      },
      contactDepartmentMembership: {
        deleteMany: membershipDeleteMany,
        createMany: membershipCreateMany,
      },
    };
    const prisma = {
      contact: {
        findMany: jest.fn(async () => [
          {
            id: 42,
            name: '旧姓名',
            phone: '13800000001',
            memberships: [
              { departmentId: 90, isPrimary: true },
              { departmentId: 91, isPrimary: false },
            ],
          },
        ]),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    return {
      service: new OrganizationService(prisma as any),
      prisma,
      tx,
      departments,
      contactUpdate,
      membershipDeleteMany,
      membershipCreateMany,
    };
  }

  const multiDepartmentRow = {
    姓名: '陶俊祎',
    手机号: '13800000001',
    部门: '闯货/员工私人号/部门负责人及大组长互评;闯货/员工私人号/杭州投放;闯货/员工私人号/品宣部',
  };

  it('shows parsed primary and secondary departments in dry-run preview', async () => {
    const { service } = createImportHarness();
    const preview = await service.importContacts([multiDepartmentRow], true);
    expect(preview.rows[0]).toMatchObject({
      action: 'update',
      primaryDepartment: '闯货/员工私人号/部门负责人及大组长互评',
      secondaryDepartments: [
        '闯货/员工私人号/杭州投放',
        '闯货/员工私人号/品宣部',
      ],
    });
  });

  it('replaces all memberships and enables evaluation for every imported department', async () => {
    const {
      service,
      prisma,
      departments,
      contactUpdate,
      membershipDeleteMany,
      membershipCreateMany,
    } = createImportHarness();
    await service.importContacts([multiDepartmentRow], false);

    expect(contactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 42 },
        data: expect.objectContaining({
          department: '闯货/员工私人号/部门负责人及大组长互评',
        }),
      }),
    );
    expect(membershipDeleteMany).toHaveBeenCalledWith({
      where: { contactId: 42 },
    });
    const importedMemberships = membershipCreateMany.mock.calls[0][0].data;
    expect(importedMemberships).toHaveLength(3);
    expect(importedMemberships.map((row) => row.isPrimary)).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      importedMemberships.every((row) => row.defaultEvalEnabled === true),
    ).toBe(true);
    expect(
      importedMemberships.map(
        (row) =>
          departments.find((department) => department.id === row.departmentId)
            ?.name,
      ),
    ).toEqual(['部门负责人及大组长互评', '杭州投放', '品宣部']);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 120_000,
    });
  });

  it('reuses resolved department paths within the same import transaction', async () => {
    const { service, tx } = createImportHarness();
    await service.importContacts(
      [
        multiDepartmentRow,
        {
          ...multiDepartmentRow,
          姓名: '第二位员工',
          手机号: '13800000002',
        },
      ],
      false,
    );

    expect(tx.orgDepartment.findFirst).toHaveBeenCalledTimes(5);
  });

  it('marks duplicate department paths as invalid', async () => {
    const { service } = createImportHarness();
    const preview = await service.importContacts(
      [
        {
          ...multiDepartmentRow,
          部门: '闯货/员工私人号/杭州投放；闯货／员工私人号／杭州投放',
        },
      ],
      true,
    );
    expect(preview.summary.skip).toBe(1);
    expect(preview.rows[0]).toMatchObject({
      action: 'skip',
      reason: '同一行重复声明部门：闯货/员工私人号/杭州投放',
    });
  });
});
