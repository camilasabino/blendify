import type { GenerationPhase, GenerationProgress } from '@blendify/contracts';
import type { Response } from 'express';
import { writeNdjsonGeneration } from './ndjson-generation';

function captureResponse() {
  const lines: string[] = [];
  const res = {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn((chunk: string) => {
      lines.push(chunk);
      return true;
    }),
    end: jest.fn(),
  };
  return { res: res as unknown as Response, lines };
}

function progress(
  phase: GenerationPhase,
  percent: number,
  current = 0,
  total = 10,
): GenerationProgress {
  return { phase, current, total, percent, etaSeconds: null };
}

function events(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('writeNdjsonGeneration progress monotonicity', () => {
  it('drops a lower percent and keeps an equal percent when the phase changes', async () => {
    const { res, lines } = captureResponse();

    await writeNdjsonGeneration(res, (onProgress) => {
      onProgress(progress('resolving_seeds', 10, 1, 1));
      onProgress(progress('resolving_seeds', 0, 0, 10));
      onProgress(progress('matching_tracks', 10, 0, 10));
      onProgress(progress('matching_tracks', 34, 3, 10));
      return Promise.resolve({ id: 'playlist' });
    });

    expect(events(lines)).toEqual([
      expect.objectContaining({
        type: 'progress',
        phase: 'resolving_seeds',
        percent: 10,
      }),
      expect.objectContaining({
        type: 'progress',
        phase: 'matching_tracks',
        current: 0,
        total: 10,
        percent: 10,
      }),
      expect.objectContaining({
        type: 'progress',
        phase: 'matching_tracks',
        percent: 34,
      }),
      expect.objectContaining({ type: 'result', playlist: { id: 'playlist' } }),
    ]);
  });

  it('keeps later progress that advances the percent, including a partial search', async () => {
    const { res, lines } = captureResponse();

    await writeNdjsonGeneration(res, (onProgress) => {
      onProgress(progress('matching_tracks', 58, 6, 10));
      onProgress(progress('matching_tracks', 42, 4, 10));
      onProgress(progress('matching_tracks', 74, 8, 10));
      return Promise.resolve({ id: 'generated' });
    });

    expect(events(lines).map((event) => event.percent ?? event.type)).toEqual([
      58,
      74,
      'result',
    ]);
    expect(events(lines)[1]).toMatchObject({
      phase: 'matching_tracks',
      current: 8,
      total: 10,
    });
    expect(events(lines).some((event) => event.current === 10)).toBe(false);
  });
});
