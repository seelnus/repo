import { EvalFillUser, EvalService } from './eval.service';

const fillUser: EvalFillUser = {
  sub: 22,
  wecomUserid: 'employee-22',
  name: '员工甲',
  type: 'fill',
};

describe('EvalService employee fill tasks', () => {
  it('returns the cycle deadline and only requests published tasks for the signed-in employee', async () => {
    const endAt = new Date('2099-09-13T10:00:00.000Z');
    const prisma: any = {
      evalRelation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 301,
            cycleId: 8,
            raterContactId: 22,
            rateeContactId: 23,
            relationType: 'peer',
            surveyId: 6,
            responseId: null,
            cycle: {
              id: 8,
              name: '第三季度 360 环评',
              status: 'published',
              version: 2,
              startAt: new Date('2020-09-01T00:00:00.000Z'),
              endAt,
            },
          },
        ]),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([{ id: 23, name: '员工乙' }]),
      },
      survey: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 6, title: '同事协作评价' }]),
      },
      evalCycleParticipant: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new EvalService(prisma, {} as never);

    const result = await service.listMyTasks(fillUser);

    expect(prisma.evalRelation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          raterContactId: 22,
          status: { not: 'exempt' },
          cycle: { status: 'published' },
        },
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        cycleId: 8,
        cycleName: '第三季度 360 环评',
        cycleStatus: 'published',
        cycleEndAt: endAt,
        tasks: [
          expect.objectContaining({
            relationId: 301,
            rateeName: '员工乙',
            surveyTitle: '同事协作评价',
            done: false,
          }),
        ],
      }),
    ]);
  });
});
