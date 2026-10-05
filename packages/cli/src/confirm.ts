import { once } from 'node:events';
import readline from 'node:readline/promises';

/** Only `yes` approves, so a stray Enter runs nothing. */
export async function confirm(question: string): Promise<boolean> {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Closed input counts as no.
    const answer = await Promise.race([terminal.question(`${question} Only "yes" is accepted: `), once(terminal, 'close').then(() => '')]);
    return answer.trim() === 'yes';
  } finally {
    terminal.close();
  }
}
