export function requestData() {
  return {
    competition_name: 'Synthetic test', competition_date: '2026-10-01', num_stations: 3,
    events: [{ event_id: '333', event_name: '3x3x3', num_groups: 4, num_scramblers_per_group: 1,
      use_runners: false, num_runners_per_group: 0 }],
    competitors: Array.from({ length: 12 }, (_, index) => ({
      competitor_id: String(index), name: `参加者${index}`, wca_id: `TEST${index}`, age: 25,
      is_newcomer: false, is_judge_exempt: false, is_scrambler_exempt: false, is_staff: false,
      events: { '333': { best_time: 5 + index, average_time: 10 + index } },
    })),
    options: { time_limit_seconds: 5, scrambler_speed_weight: 100, balance_weight: 50, judge_exempt_age: 12 },
  }
}

export const bytes = (text) => new TextEncoder().encode(text)
