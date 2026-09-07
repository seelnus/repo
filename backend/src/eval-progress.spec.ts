import { NotFoundException } from '@nestjs/common';
import { EvalService } from './eval.service';

function groupSnapshot(
  departmentId: number,
  name: string,
  path: string,
  primary: boolean,
) {
  return {
    id: departmentId,
    participantId: 1,
    departmentId,
    departmentCodeSnapshot: `D${departmentId}`,
    departmentNameSnapshot: name,
    departmentPathSnapshot: path,
    isPrimarySnapshot: primary,
    evalEnabled: true,
    roleNameSnapshot: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('EvalService rater progress', () => {
  it('groups self, peer and leader tasks by completed state', async () => {
    const sharedPath = '运营部/查曌激活组';
    const rater = {
      id: 1,
      cycleId: 5,
      contactId: 132,
      nameSnapshot: '丁史远',
      groupKey: '97',
      groupName: sharedPath,
      groupSnapshots: [groupSnapshot(97, '查曌激活组', sharedPath, true)],
    };
    const ratee = {
      id: 2,
      cycleId: 5,
      contactId: 187,
      nameSnapshot: '查曌',
      groupKey: '113',
      groupName: '运营部/查曌组',
      groupSnapshots: [groupSnapshot(97, '查曌激活组', sharedPath, false)],
    };
    const relations = [
      {
        id: 1,
        cycleId: 5,
        raterContactId: 132,
        rateeContactId: 132,
        relationType: 'self',
        source: 'auto',
        status: 'pending',
        responseId: null,
      },
      {
        id: 2,
        cycleId: 5,
        raterContactId: 132,
        rateeContactId: 187,
        relationType: 'peer',
        source: 'auto',
        status: 'submitted',
        responseId: 100,
      },
      {
        id: 3,
        cycleId: 5,
        raterContactId: 132,
        rateeContactId: 200,
        relationType: 'leader',
        source: 'manual',
        status: 'submitted',
        responseId: null,
      },
    ];
    const prisma: any = {
      evalCycleParticipant: {
        findUnique: jest.fn().mockResolvedValue(rater),
        findMany: jest.fn().mockResolvedValue([rater, ratee]),
      },
      evalRelation: {
        findMany: jest.fn().mockResolvedValue(relations),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([
          { id: 132, name: '当前丁史远' },
          { id: 187, name: '当前查曌' },
          { id: 200, name: '人工对象' },
        ]),
      },
    };
    const service = new EvalService(prisma, {} as never) as any;
    service.getCycle = jest.fn().mockResolvedValue({ id: 5 });

    const result = await service.getRaterProgress(5, 132);

    expect(result.summary).toEqual({
      total: 3,
      completed: 1,
      pending: 2,
      completionRate: 1 / 3,
    });
    expect(result.groups).toEqual([
      expect.objectContaining({
        type: 'self',
        completedCount: 0,
        pending: [expect.objectContaining({ name: '丁史远' })],
      }),
      expect.objectContaining({
        type: 'peer',
        completedCount: 1,
        completed: [
          expect.objectContaining({
            name: '查曌',
            sharedGroups: [
              expect.objectContaining({
                name: '查曌激活组',
                path: sharedPath,
              }),
            ],
          }),
        ],
      }),
      expect.objectContaining({
        type: 'leader',
        pendingCount: 1,
        pending: [
          expect.objectContaining({ name: '人工对象', source: 'manual' }),
        ],
      }),
    ]);
  });

  it('rejects a contact outside the cycle', async () => {
    const prisma: any = {
      evalCycleParticipant: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new EvalService(prisma, {} as never) as any;
    service.getCycle = jest.fn().mockResolvedValue({ id: 5 });

    await expect(service.getRaterProgress(5, 999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
