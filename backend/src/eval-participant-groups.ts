export type MultiGroupRelationType = 'self' | 'peer';

export interface ParticipantGroupSnapshotInput {
  departmentId: number;
  departmentNameSnapshot: string;
  departmentPathSnapshot: string;
  isPrimarySnapshot: boolean;
  evalEnabled: boolean;
}

export interface MultiGroupParticipant {
  participantId: number;
  contactId: number;
  mode: string;
  groups: ParticipantGroupSnapshotInput[];
}

export interface MultiGroupRelationCandidate {
  raterContactId: number;
  rateeContactId: number;
  relationType: MultiGroupRelationType;
}

export interface SharedEvaluationGroup {
  departmentId: number;
  name: string;
  path: string;
}

export interface MultiGroupGenerationReport {
  relations: MultiGroupRelationCandidate[];
  selfCount: number;
  peerCount: number;
  coveredGroupCount: number;
  groupReports: Array<{
    departmentId: number;
    groupName: string;
    groupPath: string;
    normalCount: number;
    peerCandidateCount: number;
    warning?: string;
  }>;
  warnings: string[];
}

function relationKey(raterContactId: number, rateeContactId: number) {
  return `${raterContactId}:${rateeContactId}`;
}

export function buildMultiGroupAutoRelations(
  participants: MultiGroupParticipant[],
): MultiGroupGenerationReport {
  const normalParticipants = participants.filter(
    (participant) => participant.mode === 'normal',
  );
  const relations = new Map<string, MultiGroupRelationCandidate>();

  for (const participant of normalParticipants) {
    relations.set(relationKey(participant.contactId, participant.contactId), {
      raterContactId: participant.contactId,
      rateeContactId: participant.contactId,
      relationType: 'self',
    });
  }

  const groups = new Map<
    number,
    {
      name: string;
      path: string;
      participants: Map<number, MultiGroupParticipant>;
    }
  >();
  for (const participant of normalParticipants) {
    for (const group of participant.groups.filter((item) => item.evalEnabled)) {
      const bucket = groups.get(group.departmentId) || {
        name: group.departmentNameSnapshot,
        path: group.departmentPathSnapshot,
        participants: new Map<number, MultiGroupParticipant>(),
      };
      bucket.participants.set(participant.contactId, participant);
      groups.set(group.departmentId, bucket);
    }
  }

  const groupReports: MultiGroupGenerationReport['groupReports'] = [];
  const warnings: string[] = [];
  for (const [departmentId, group] of groups) {
    const members = Array.from(group.participants.values()).sort(
      (left, right) => left.contactId - right.contactId,
    );
    for (const rater of members) {
      for (const ratee of members) {
        if (rater.contactId === ratee.contactId) continue;
        const key = relationKey(rater.contactId, ratee.contactId);
        if (!relations.has(key)) {
          relations.set(key, {
            raterContactId: rater.contactId,
            rateeContactId: ratee.contactId,
            relationType: 'peer',
          });
        }
      }
    }
    const warning =
      members.length === 1
        ? `${group.path}：单人组只有自评，请人工补配跨组评价或登记他评豁免`
        : undefined;
    if (warning) warnings.push(warning);
    groupReports.push({
      departmentId,
      groupName: group.name,
      groupPath: group.path,
      normalCount: members.length,
      peerCandidateCount: members.length * Math.max(0, members.length - 1),
      ...(warning ? { warning } : {}),
    });
  }

  const values = Array.from(relations.values());
  return {
    relations: values,
    selfCount: values.filter((relation) => relation.relationType === 'self')
      .length,
    peerCount: values.filter((relation) => relation.relationType === 'peer')
      .length,
    coveredGroupCount: groups.size,
    groupReports,
    warnings,
  };
}

export function findSharedEnabledGroups(
  firstGroups: ParticipantGroupSnapshotInput[],
  secondGroups: ParticipantGroupSnapshotInput[],
): SharedEvaluationGroup[] {
  const secondIds = new Set(
    secondGroups
      .filter((group) => group.evalEnabled)
      .map((group) => group.departmentId),
  );
  return firstGroups
    .filter((group) => group.evalEnabled && secondIds.has(group.departmentId))
    .map((group) => ({
      departmentId: group.departmentId,
      name: group.departmentNameSnapshot,
      path: group.departmentPathSnapshot,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}
