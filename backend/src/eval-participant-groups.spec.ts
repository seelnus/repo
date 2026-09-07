import {
  buildMultiGroupAutoRelations,
  findSharedEnabledGroups,
  type MultiGroupParticipant,
} from './eval-participant-groups';

function participant(
  contactId: number,
  groups: Array<{
    departmentId: number;
    name: string;
    path?: string;
    enabled?: boolean;
    primary?: boolean;
  }>,
  mode = 'normal',
): MultiGroupParticipant {
  return {
    participantId: contactId + 1000,
    contactId,
    mode,
    groups: groups.map((group) => ({
      departmentId: group.departmentId,
      departmentNameSnapshot: group.name,
      departmentPathSnapshot: group.path || group.name,
      isPrimarySnapshot: Boolean(group.primary),
      evalEnabled: group.enabled !== false,
    })),
  };
}

describe('buildMultiGroupAutoRelations', () => {
  it('creates one self relation per person and two peer directions in one group', () => {
    const result = buildMultiGroupAutoRelations([
      participant(1, [{ departmentId: 10, name: '技术部', primary: true }]),
      participant(2, [{ departmentId: 10, name: '技术部', primary: true }]),
    ]);

    expect(result.relations).toEqual([
      { raterContactId: 1, rateeContactId: 1, relationType: 'self' },
      { raterContactId: 2, rateeContactId: 2, relationType: 'self' },
      { raterContactId: 1, rateeContactId: 2, relationType: 'peer' },
      { raterContactId: 2, rateeContactId: 1, relationType: 'peer' },
    ]);
    expect(result.selfCount).toBe(2);
    expect(result.peerCount).toBe(2);
  });

  it('connects a secondary membership to another persons primary group', () => {
    const result = buildMultiGroupAutoRelations([
      participant(132, [
        {
          departmentId: 97,
          name: '查曌激活组',
          path: '运营部/查曌激活组',
          primary: true,
        },
      ]),
      participant(187, [
        { departmentId: 113, name: '查曌组', primary: true },
        {
          departmentId: 97,
          name: '查曌激活组',
          path: '运营部/查曌激活组',
        },
      ]),
    ]);

    expect(result.relations).toContainEqual({
      raterContactId: 132,
      rateeContactId: 187,
      relationType: 'peer',
    });
    expect(result.relations).toContainEqual({
      raterContactId: 187,
      rateeContactId: 132,
      relationType: 'peer',
    });
  });

  it('deduplicates directed pairs shared through multiple groups', () => {
    const result = buildMultiGroupAutoRelations([
      participant(1, [
        { departmentId: 10, name: 'A', primary: true },
        { departmentId: 11, name: 'B' },
      ]),
      participant(2, [
        { departmentId: 10, name: 'A', primary: true },
        { departmentId: 11, name: 'B' },
      ]),
    ]);

    expect(result.relations).toHaveLength(4);
    expect(result.peerCount).toBe(2);
    expect(result.coveredGroupCount).toBe(2);
  });

  it('ignores disabled secondary groups and special participants', () => {
    const result = buildMultiGroupAutoRelations([
      participant(1, [
        { departmentId: 10, name: 'A', primary: true },
        { departmentId: 11, name: 'B', enabled: false },
      ]),
      participant(2, [{ departmentId: 11, name: 'B', primary: true }]),
      participant(
        3,
        [{ departmentId: 10, name: 'A', primary: true }],
        'special',
      ),
    ]);

    expect(result.relations).toEqual([
      { raterContactId: 1, rateeContactId: 1, relationType: 'self' },
      { raterContactId: 2, rateeContactId: 2, relationType: 'self' },
    ]);
  });

  it('reports a single-person enabled group without duplicating self relations', () => {
    const result = buildMultiGroupAutoRelations([
      participant(1, [
        { departmentId: 10, name: 'A', primary: true },
        { departmentId: 11, name: 'B' },
      ]),
    ]);

    expect(result.relations).toHaveLength(1);
    expect(result.groupReports).toEqual([
      expect.objectContaining({ departmentId: 10, normalCount: 1 }),
      expect.objectContaining({ departmentId: 11, normalCount: 1 }),
    ]);
    expect(result.warnings).toHaveLength(2);
  });
});

describe('findSharedEnabledGroups', () => {
  it('returns stable snapshot paths for all shared enabled groups', () => {
    const first = participant(1, [
      { departmentId: 10, name: 'A', path: '总部/A', primary: true },
      { departmentId: 11, name: 'B', path: '总部/B' },
    ]);
    const second = participant(2, [
      { departmentId: 10, name: '改名后的 A', path: '总部/A', primary: true },
      { departmentId: 11, name: 'B', path: '总部/B' },
      { departmentId: 12, name: 'C', path: '总部/C', enabled: false },
    ]);

    expect(findSharedEnabledGroups(first.groups, second.groups)).toEqual([
      { departmentId: 10, name: 'A', path: '总部/A' },
      { departmentId: 11, name: 'B', path: '总部/B' },
    ]);
  });
});
