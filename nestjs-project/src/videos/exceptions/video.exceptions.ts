import { DomainException } from '../../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found for user');
  }
}

export class UploadTooLargeException extends DomainException {
  constructor() {
    super('UPLOAD_TOO_LARGE', 400, 'File exceeds the maximum allowed size');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported media type');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class ForbiddenChannelException extends DomainException {
  constructor() {
    super('FORBIDDEN_CHANNEL', 403, 'You do not own this video');
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor() {
    super('INVALID_UPLOAD_STATE', 409, 'Upload is not in a completable state');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
