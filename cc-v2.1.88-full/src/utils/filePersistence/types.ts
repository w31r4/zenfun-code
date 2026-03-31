export const OUTPUTS_SUBDIR = 'outputs'

// Safety cap for number of modified files processed per turn.
export const FILE_COUNT_LIMIT = 1000

export const DEFAULT_UPLOAD_CONCURRENCY = 5

export type TurnStartTime = number

export type PersistedFile = {
  filename: string
  file_id: string
}

export type FailedPersistence = {
  filename: string
  error: string
}

export type FilesPersistedEventData = {
  files: PersistedFile[]
  failed: FailedPersistence[]
}
