import { once } from 'node:events';
import readline from 'node:readline/promises';

/** Only `yes` approves, so a stray Enter runs nothing. */
export async function confirm(question: string): Promise<boolean> {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Closed input is most often a pipeline that left out the flag.
    const closed = once(terminal, 'close').then(() => {
      throw new Error('No answer: the input is closed. Run with --yes to approve without asking');
    });
    const answer = await Promise.race([terminal.question(`${question} Only "yes" is accepted: `), closed]);

    return answer.trim() === 'yes';
  } finally {
    terminal.close();
  }
}
