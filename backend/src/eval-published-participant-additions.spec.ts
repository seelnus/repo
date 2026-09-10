import { BadRequestException, ConflictException } from '@nestjs/common';
import { EvalService } from './eval.service';

function department() {
  return {
    id: 10,
    code: 'TECH',
    name: '技术部',
    parentId: null,
    sortOrder: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function newContact() {
  const group = department();
  return {
    id: 2,
    name: '新成员',
    jobNo: '0002',
    position: '工程师',
    isActive: true,
    memberships: [
      {
        id: 2,
        contactId: 2,
        departmentId: group.id,
        isPrimary: true,
        defaultEvalEnabled: true,
        roleName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        department: group,
      },
    ],
  };
}

function existingParticipant() {
  return {
    id: 101,
    cycleId: 6,
    contactId: 1,
    mode: 'normal',
    groupKey: '10',
    groupName: '技术部',
    groupSnapshots: [
      {
        departmentId: 10,
        departmentNameSnapshot: '技术部',
        departmentPathSnapshot: '技术部',
        isPrimarySnapshot: true,
        evalEnabled: true,
      },
    ],
  };
}

function publishedCycle(endAt = new Date('2099-09-30T00:00:00.000Z')) {
  return {
    id: 6,
    version: 2,
    status: 'published',
    templateSurveyId: 9,
    startAt: new Date('2020-09-01T00:00:00.000Z'),
    endAt,
  };
}

describe('EvalService published participant additions', () => {
  it('previews only missing relations involving the new member', async () => {
    const prisma: any = {
      evalCycle: {
        findUnique: jest.fn().mockResolvedValue({
          ...publishedCycle(),
          _count: { relations: 2, participants: 1 },
        }),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([newContact()]),
      },
      orgDepartment: {
        findMany: jest.fn().mockResolvedValue([department()]),
      },
      evalCycleParticipant: {
        findMany: jest.fn().mockImplementation((args) =>
          args.select ? Promise.resolve([]) : Promise.resolve([existingParticipant()]),
        ),
      },
      evalRelation: {
        findMany: jest.fn().mockResolvedValue([
          { raterContactId: 1, rateeContactId: 1 },
          { raterContactId: 1, rateeContactId: 2 },
        ]),
      },
    };
    const service = new EvalService(prisma, {} as never);

    const result = await service.previewPublishedParticipantAddition(6, {
      contactIds: [2],
    });

    expect(result).toEqual(
      expect.objectContaining({
        newParticipantCount: 1,
        selfRelationCount: 1,
        peerRelationCount: 1,
        affectedExistingRaterCount: 0,
        totalRelationCount: 2,
      }),
    );
  });

  it('adds only the new snapshots and relations while existing answers may already exist', async () => {
    const participantCreate = jest.fn().mockResolvedValue({ id: 102 });
    const relationCreateMany = jest.fn().mockResolvedValue({ count: 3 });
    const auditCreate = jest.fn().mockResolvedValue({ id: 1 });
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 6 }]),
      evalCycle: {
        findUnique: jest.fn().mockResolvedValue(publishedCycle()),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([newContact()]),
      },
      orgDepartment: {
        findMany: jest.fn().mockResolvedValue([department()]),
      },
      evalCycleParticipant: {
        findMany: jest.fn().mockImplementation((args) =>
          args.select ? Promise.resolve([]) : Promise.resolve([existingParticipant()]),
        ),
        create: participantCreate,
      },
      evalRelation: {
        findMany: jest.fn().mockResolvedValue([
          {
            raterContactId: 1,
            rateeContactId: 1,
            responseId: 501,
          },
        ]),
        createMany: relationCreateMany,
      },
      evalAuditLog: { create: auditCreate },
    };
    const prisma: any = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const service = new EvalService(prisma, {} as never);

    const result = await service.addPublishedParticipants(
      6,
      { contactIds: [2] },
      99,
    );

    expect(participantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycleId: 6,
          contactId: 2,
          mode: 'normal',
          groupSnapshots: {
            create: [expect.objectContaining({ departmentId: 10 })],
          },
        }),
      }),
    );
    expect(relationCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          raterContactId: 2,
          rateeContactId: 2,
          relationType: 'self',
        }),
        expect.objectContaining({
          raterContactId: 1,
          rateeContactId: 2,
          relationType: 'peer',
        }),
        expect.objectContaining({
          raterContactId: 2,
          rateeContactId: 1,
          relationType: 'peer',
        }),
      ]),
      skipDuplicates: true,
    });
    expect(result).toEqual(
      expect.objectContaining({
        createdParticipantCount: 1,
        createdRelationCount: 3,
        selfRelationCount: 1,
        peerRelationCount: 2,
        affectedExistingRaterCount: 1,
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'add_published_participants',
          adminId: 99,
        }),
      }),
    );
  });

  it('rejects additions after the published deadline without writing data', async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 6 }]),
      evalCycle: {
        findUnique: jest
          .fn()
          .mockResolvedValue(publishedCycle(new Date('2020-09-30T00:00:00Z'))),
      },
    };
    const prisma: any = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const service = new EvalService(prisma, {} as never);

    await expect(
      service.addPublishedParticipants(6, { contactIds: [2] }, 99),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.evalCycleParticipant).toBeUndefined();
  });

  it('rejects a member who is already in the batch', async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 6 }]),
      evalCycle: {
        findUnique: jest.fn().mockResolvedValue(publishedCycle()),
      },
      evalCycleParticipant: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ contactId: 2, nameSnapshot: '新成员' }]),
      },
    };
    const prisma: any = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const service = new EvalService(prisma, {} as never);

    await expect(
      service.addPublishedParticipants(6, { contactIds: [2] }, 99),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
