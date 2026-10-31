import { createColors } from 'picocolors';

function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  const forced = env.FORCE_COLOR;
  return (forced !== undefined && forced !== '' && forced !== '0') || (isTTY === true && env.NO_COLOR === undefined);
}

export function showSpinner(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  return isTTY === true && colorEnabled(env, isTTY);
}

export const colors = createColors(colorEnabled(process.env, process.stdout.isTTY));
