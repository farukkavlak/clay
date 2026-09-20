import { once } from 'node:events';
import readline from 'node:readline/promises';

/** Asks on the terminal. Only a plain `yes` approves, as in Terraform, so a stray Enter runs nothing. */
export async function confirm(question: string): Promise<boolean> {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Input that ends before an answer is no answer.
    const answer = await Promise.race([terminal.question(`${question} Only "yes" is accepted: `), once(terminal, 'close').then(() => '')]);
    return answer.trim() === 'yes';
  } finally {
    terminal.close();
  }
}
