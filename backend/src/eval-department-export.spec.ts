import * as ExcelJS from 'exceljs';
import { buildDepartmentSummaryRows, EvalService } from './eval.service';

function participant(
  contactId: number,
  paths: string[],
  totalScore: number | null,
  dimensions: Array<{ dimensionId: string; score: number | null }> = [],
) {
  return {
    contactId,
    departmentSnapshot: paths[0] || null,
    groupSnapshots: paths.map((departmentPathSnapshot) => ({
      departmentPathSnapshot,
    })),
    result: {
      totalScore,
      dimensionScoresJson: dimensions,
    },
  };
}

describe('buildDepartmentSummaryRows', () => {
  it('rolls primary and secondary departments up and deduplicates shared ancestors', () => {
    const rows = buildDepartmentSummaryRows(
      [
        participant(
          1,
          ['公司/运营部/A组', '公司/运营部/B组'],
          4,
          [
            { dimensionId: 'd1', score: 5 },
            { dimensionId: 'd2', score: 3 },
          ],
        ),
        participant(2, ['公司/运营部/B组'], 2, [
          { dimensionId: 'd1', score: 1 },
          { dimensionId: 'd2', score: 3 },
        ]),
      ],
      ['d1', 'd2'],
    );

    expect(rows.map((row) => row.path)).toEqual([
      '公司',
      '公司/运营部',
      '公司/运营部/A组',
      '公司/运营部/B组',
    ]);
    expect(rows.find((row) => row.path === '公司/运营部')).toEqual(
      expect.objectContaining({
        participantCount: 2,
        scoredParticipantCount: 2,
        dimensionAverages: { d1: 3, d2: 3 },
        totalAverage: 3,
      }),
    );
    expect(rows.find((row) => row.path === '公司/运营部/B组')).toEqual(
      expect.objectContaining({ participantCount: 2, totalAverage: 3 }),
    );
  });

  it('keeps unscored employees in headcount but excludes them from averages', () => {
    const rows = buildDepartmentSummaryRows(
      [
        participant(1, ['公司/技术部'], null),
        participant(2, ['公司/技术部'], 4, [
          { dimensionId: 'd1', score: 5 },
        ]),
        participant(3, ['公司/技术部'], 2, []),
      ],
      ['d1', 'd2'],
    );
    const department = rows.find((row) => row.path === '公司/技术部');

    expect(department).toEqual(
      expect.objectContaining({
        participantCount: 3,
        scoredParticipantCount: 2,
        dimensionAverages: { d1: 5, d2: null },
        totalAverage: 3,
      }),
    );
  });

  it('falls back to the participant department when group snapshots are absent', () => {
    const rows = buildDepartmentSummaryRows(
      [
        {
          contactId: 1,
          departmentSnapshot: '公司/人力资源部',
          groupSnapshots: [],
          result: null,
        },
      ],
      [],
    );

    expect(rows.map((row) => row.path)).toEqual(['公司', '公司/人力资源部']);
    expect(rows[1].participantCount).toBe(1);
  });

  it('adds a department data worksheet to the v2 export', async () => {
    const service = new EvalService({} as never, {} as never) as any;
    service.getCycle = jest.fn().mockResolvedValue({
      id: 5,
      version: 2,
      templateSurveyId: null,
      templateSnapshotJson: {
        version: 2,
        kind: 'evaluation',
        dimensions: [
          { id: 'd1', name: '诚信', order: 1 },
          { id: 'd2', name: '协作', order: 2 },
        ],
        questions: [],
      },
    });
    service.listResults = jest.fn().mockResolvedValue([
      participant(1, ['公司/运营部/A组', '公司/运营部/B组'], 4, [
        { dimensionId: 'd1', score: 5 },
        { dimensionId: 'd2', score: 3 },
      ]),
    ]);
    service.listRawResponses = jest.fn().mockResolvedValue([]);

    const buffer = await service.exportCycle(5);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('部门数据');

    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).values).toEqual([
      undefined,
      '部门层级',
      '部门名称',
      '完整部门路径',
      '部门人数',
      '已评分人数',
      '诚信平均分',
      '协作平均分',
      '总平均分',
    ]);
    expect(sheet!.getRow(2).values).toEqual([
      undefined,
      1,
      '公司',
      '公司',
      1,
      1,
      5,
      3,
      4,
    ]);
    expect(sheet!.views).toEqual([
      expect.objectContaining({ state: 'frozen', ySplit: 1 }),
    ]);
  });
});
