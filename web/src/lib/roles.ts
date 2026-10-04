export const roleLabels = {
  COMPETITOR: '競技者',
  SCRAMBLER: 'スクランブラー',
  JUDGE: 'ジャッジ',
  RUNNER: 'ランナー',
} as const

export type Role = keyof typeof roleLabels
