// The playtester's name, kept per browser so runs from several people can be told apart.
const KEY = 'train-robber-tester';

export function getTester(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function setTester(name: string): void {
  try { localStorage.setItem(KEY, name); } catch { /* storage blocked: the name lasts for this page only */ }
}
