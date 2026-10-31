export type PreviewErrorCode =
  'PREVIEW_NOT_FOUND' | 'PREVIEW_SAVE_IN_PROGRESS' | 'CLIENT_OUTDATED';

export class PreviewError extends Error {
  private constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static notFound(): PreviewError {
    return new PreviewError(
      'PREVIEW_NOT_FOUND',
      'This playlist preview is no longer available. Generate it again.',
    );
  }

  static saveInProgress(): PreviewError {
    return new PreviewError(
      'PREVIEW_SAVE_IN_PROGRESS',
      'This playlist is already being saved to Spotify.',
    );
  }

  static clientOutdated(): PreviewError {
    return new PreviewError(
      'CLIENT_OUTDATED',
      'This version of Blendify is outdated. Reload the page to continue.',
    );
  }
}
