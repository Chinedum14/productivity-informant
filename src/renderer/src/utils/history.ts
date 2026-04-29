export interface DailyMetrics {
  date: string;
  githubCount: number;
  githubCompleted: boolean;
  fileCompleted: boolean;
  algoTradingCompleted?: boolean;
  readingPages: number;
  readingCompleted: boolean;
  socialCompleted?: boolean;
  score: number;
}

export function saveDailyMetrics(metrics: DailyMetrics) {
  const historyRaw = localStorage.getItem('metrics-history') || '[]';
  const history: DailyMetrics[] = JSON.parse(historyRaw);
  
  // Find if today already exists and update, or push new
  const index = history.findIndex(m => m.date === metrics.date);
  if (index !== -1) {
    history[index] = metrics;
  } else {
    history.push(metrics);
  }
  
  // Keep only last 30 days
  const recentHistory = history.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  localStorage.setItem('metrics-history', JSON.stringify(recentHistory));
}

export function getWeeklyHistory(): DailyMetrics[] {
  const historyRaw = localStorage.getItem('metrics-history') || '[]';
  const history: DailyMetrics[] = JSON.parse(historyRaw);
  
  // Sort by date ascending for charts
  return history.sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
}

export function getWeeklyReport() {
  const history = getWeeklyHistory();
  if (history.length === 0) return null;
  
  const avgScore = history.reduce((sum, m) => sum + m.score, 0) / history.length;
  const totalCommits = history.reduce((sum, m) => sum + m.githubCount, 0);
  const totalPages = history.reduce((sum, m) => sum + m.readingPages, 0);
  
  return {
    avgScore: Math.round(avgScore),
    totalCommits,
    totalPages,
    daysTracked: history.length
  };
}
