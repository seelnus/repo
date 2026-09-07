import { EvalService } from './eval.service';

function department(
  id: number,
  name: string,
  parentId: number | null,
  isActive = true,
) {
  return {
    id,
    code: `D${id}`,
    name,
    parentId,
    sortOrder: id,
    isActive,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function membership(
  id: number,
  contactId: number,
  dept: ReturnType<typeof department>,
  isPrimary: boolean,
  defaultEvalEnabled: boolean,
) {
  return {
    id,
    contactId,
    departmentId: dept.id,
    isPrimary,
    defaultEvalEnabled,
    roleName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    department: dept,
  };
}

describe('EvalService multi-department snapshots', () => {
  it('forces the primary group on and inherits enabled secondary memberships', async () => {
    const root = department(1, '运营部', null);
    const primary = department(97, '查曌激活组', 1);
    const secondary = department(113, '查曌组', 1);
    const prisma = {
      contact: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 187,
            name: '查曌',
            jobNo: '0187',
            position: '主管',
            isActive: true,
            memberships: [
              membership(1, 187, secondary, true, false),
              membership(2, 187, primary, false, true),
            ],
          },
        ]),
      },
      orgDepartment: {
        findMany: jest.fn().mockResolvedValue([root, primary, secondary]),
      },
    };
    const service = new EvalService(prisma as never, {} as never) as any;

    const result = await service.planParticipantSnapshots([187]);

    expect(result.participants[0].groups).toEqual([
      expect.objectContaining({
        departmentId: 113,
        isPrimarySnapshot: true,
        evalEnabled: true,
      }),
      expect.objectContaining({
        departmentId: 97,
        isPrimarySnapshot: false,
        evalEnabled: true,
      }),
    ]);
    expect(result.summary.multiGroupParticipantCount).toBe(1);
  });

  it('allows a primary membership with children and returns a preview warning', async () => {
    const root = department(1, '运营部', null);
    const child = department(2, '下级组', 1);
    const prisma = {
      contact: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            name: '测试员工',
            jobNo: null,
            position: null,
            isActive: true,
            memberships: [membership(1, 1, root, true, false)],
          },
        ]),
      },
      orgDepartment: {
        findMany: jest.fn().mockResolvedValue([root, child]),
      },
    };
    const service = new EvalService(prisma as never, {} as never) as any;

    const result = await service.planParticipantSnapshots([1]);

    expect(result.participants).toHaveLength(1);
    expect(result.summary.warnings).toEqual([
      expect.stringContaining('仍仅按本人明确归属参与互评'),
    ]);
  });
});

describe('EvalService multi-department relation generation', () => {
  it('generates the Ding Shiyuan and Zhaozhao peer directions from a shared snapshot group', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 4 });
    const prisma: any = {
      evalCycle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 5,
          version: 2,
          status: 'draft',
          templateSurveyId: 9,
          _count: { relations: 0, participants: 2 },
        }),
      },
      survey: {
        findFirst: jest.fn().mockResolvedValue({
          id: 9,
          type: 'evaluation',
          isDeleted: false,
        }),
      },
      evalCycleParticipant: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            cycleId: 5,
            contactId: 132,
            mode: 'normal',
            groupKey: '97',
            groupName: '运营部/查曌激活组',
            groupSnapshots: [
              {
                departmentId: 97,
                departmentNameSnapshot: '查曌激活组',
                departmentPathSnapshot: '运营部/查曌激活组',
                isPrimarySnapshot: true,
                evalEnabled: true,
              },
            ],
          },
          {
            id: 2,
            cycleId: 5,
            contactId: 187,
            mode: 'normal',
            groupKey: '113',
            groupName: '运营部/查曌组',
            groupSnapshots: [
              {
                departmentId: 113,
                departmentNameSnapshot: '查曌组',
                departmentPathSnapshot: '运营部/查曌组',
                isPrimarySnapshot: true,
                evalEnabled: true,
              },
              {
                departmentId: 97,
                departmentNameSnapshot: '查曌激活组',
                departmentPathSnapshot: '运营部/查曌激活组',
                isPrimarySnapshot: false,
                evalEnabled: true,
              },
            ],
          },
        ]),
      },
      evalRelation: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany,
      },
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const service = new EvalService(prisma, {} as never) as any;

    const report = await service.generateV2Relations(5);

    expect(report.selfCount).toBe(2);
    expect(report.peerCount).toBe(2);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            raterContactId: 132,
            rateeContactId: 187,
            relationType: 'peer',
          }),
          expect.objectContaining({
            raterContactId: 187,
            rateeContactId: 132,
            relationType: 'peer',
          }),
        ]),
      }),
    );
  });
});
