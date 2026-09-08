import { NotFoundException } from '@nestjs/common';
import { EvalFillUser, EvalService } from './eval.service';

const fillUser: EvalFillUser = {
  sub: 22,
  wecomUserid: 'user-22',
  name: '员工甲',
  type: 'fill',
};

describe('EvalService employee archived results', () => {
  it('lists only the archived participant rows provided by the scoped query', async () => {
    const archivedAt = new Date('2026-09-01T08:00:00Z');
    const prisma: any = {
      evalCycleParticipant: {
        findMany: jest.fn().mockResolvedValue([
          {
            cycleId: 7,
            contactId: 22,
            cycle: { id: 7, name: '第三季度环评', archivedAt },
          },
        ]),
      },
      evalEmployeeResult: {
        findMany: jest.fn().mockResolvedValue([
          {
            cycleId: 7,
            rateeContactId: 22,
            totalScore: '4.25',
            receivedCount: 5,
            expectedCount: 6,
          },
        ]),
      },
    };
    const service = new EvalService(prisma, {} as never);

    await expect(service.listMyArchivedResults(fillUser)).resolves.toEqual([
      {
        cycleId: 7,
        cycleName: '第三季度环评',
        archivedAt,
        resultAvailable: true,
        totalScore: 4.25,
        receivedCount: 5,
        expectedCount: 6,
      },
    ]);
    expect(prisma.evalCycleParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contactId: 22,
          cycle: { status: 'archived' },
        },
      }),
    );
    expect(prisma.evalEmployeeResult.findMany).toHaveBeenCalledWith({
      where: { cycleId: { in: [7] }, rateeContactId: 22 },
      select: {
        cycleId: true,
        totalScore: true,
        receivedCount: true,
        expectedCount: true,
      },
    });
  });

  it('keeps an archived cycle visible when its result record is missing', async () => {
    const prisma: any = {
      evalCycleParticipant: {
        findMany: jest.fn().mockResolvedValue([
          {
            cycleId: 8,
            contactId: 22,
            cycle: {
              id: 8,
              name: '缺少结果的环评',
              archivedAt: new Date('2026-08-01T08:00:00Z'),
            },
          },
        ]),
      },
      evalEmployeeResult: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new EvalService(prisma, {} as never);

    const [item] = await service.listMyArchivedResults(fillUser);

    expect(item).toEqual(
      expect.objectContaining({
        cycleId: 8,
        resultAvailable: false,
        totalScore: null,
        receivedCount: 0,
        expectedCount: 0,
      }),
    );
  });

  it('returns only the employee-safe aggregate score fields', async () => {
    const archivedAt = new Date('2026-09-01T08:00:00Z');
    const prisma: any = {
      evalCycleParticipant: {
        findFirst: jest.fn().mockResolvedValue({
          cycleId: 7,
          contactId: 22,
          nameSnapshot: '员工甲',
          cycle: {
            id: 7,
            name: '第三季度环评',
            status: 'archived',
            archivedAt,
          },
        }),
      },
      evalEmployeeResult: {
        findUnique: jest.fn().mockResolvedValue({
          cycleId: 7,
          rateeContactId: 22,
          totalScore: '4.25',
          receivedCount: 5,
          expectedCount: 6,
          dimensionScoresJson: [
            { dimensionId: 'd1', name: '价值观', score: '4.50', secret: 'x' },
          ],
          questionScoresJson: [
            {
              questionId: 'q1',
              label: '主动担当',
              selfScore: 4,
              otherScore: '4.50',
              score: '4.25',
              answerCount: 5,
              caseText: '不得返回',
            },
          ],
          cases: [{ caseText: '不得返回' }],
          textFeedback: [{ text: '不得返回' }],
          answersJson: { q1: '不得返回' },
        }),
      },
    };
    const service = new EvalService(prisma, {} as never);

    const report = await service.getMyArchivedResult(7, fillUser);

    expect(report).toEqual({
      cycle: {
        id: 7,
        name: '第三季度环评',
        status: 'archived',
        archivedAt,
      },
      participant: { contactId: 22, name: '员工甲' },
      result: {
        totalScore: 4.25,
        receivedCount: 5,
        expectedCount: 6,
        dimensionScores: [{ dimensionId: 'd1', name: '价值观', score: 4.5 }],
        questionScores: [
          {
            questionId: 'q1',
            label: '主动担当',
            selfScore: 4,
            otherScore: 4.5,
            score: 4.25,
            answerCount: 5,
          },
        ],
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /caseText|textFeedback|answersJson|不得返回/,
    );
    expect(prisma.evalCycleParticipant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cycleId: 7,
          contactId: 22,
          cycle: { status: 'archived' },
        },
      }),
    );
    expect(prisma.evalEmployeeResult.findUnique).toHaveBeenCalledWith({
      where: {
        cycleId_rateeContactId: { cycleId: 7, rateeContactId: 22 },
      },
      select: {
        totalScore: true,
        receivedCount: true,
        expectedCount: true,
        dimensionScoresJson: true,
        questionScoresJson: true,
      },
    });
  });

  it('uses the same unavailable response for inaccessible or missing results', async () => {
    const noParticipantPrisma: any = {
      evalCycleParticipant: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const noResultPrisma: any = {
      evalCycleParticipant: {
        findFirst: jest.fn().mockResolvedValue({
          cycleId: 7,
          contactId: 22,
          nameSnapshot: '员工甲',
          cycle: { id: 7, name: '环评', archivedAt: new Date() },
        }),
      },
      evalEmployeeResult: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    for (const prisma of [noParticipantPrisma, noResultPrisma]) {
      const service = new EvalService(prisma, {} as never);
      await expect(service.getMyArchivedResult(7, fillUser)).rejects.toEqual(
        new NotFoundException('个人环评结果不存在或暂不可查看'),
      );
    }
  });
});
