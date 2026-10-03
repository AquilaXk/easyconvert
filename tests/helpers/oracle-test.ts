import { it, type TestContext } from 'vitest';
import { ExternalOracleTool, getOracleToolPath, OracleToolMissingError } from './differential-oracle';

export type OracleTestFn = (ctx: TestContext) => void | Promise<void>;

export interface OracleTestInterface {
  (name: string, tools: ExternalOracleTool[], fn: OracleTestFn, timeout?: number): void;
  skip: typeof it.skip;
  only: typeof it.only;
}

export const oracleTest: OracleTestInterface = Object.assign(
  (
    name: string,
    tools: ExternalOracleTool[],
    fn: OracleTestFn,
    timeout?: number
  ): void => {
    it(
      name,
      async (ctx: TestContext) => {
        const toolList = Array.isArray(tools) ? tools : [tools];
        const missingTools: ExternalOracleTool[] = [];
        for (const tool of toolList) {
          if (!getOracleToolPath(tool)) {
            missingTools.push(tool);
          }
        }

        const isStrict = process.env.ORACLE_STRICT_MODE === '1';

        if (missingTools.length > 0) {
          const err = new OracleToolMissingError(
            missingTools.join(', '),
            `Oracle CLI tool(s) missing: ${missingTools.join(', ')}`
          );
          if (isStrict) {
            throw err;
          }
          (ctx as any).skip();
          return;
        }

        try {
          await fn(ctx);
        } catch (err: any) {
          if (err instanceof OracleToolMissingError || err?.isOracleSkip) {
            if (isStrict) {
              throw err;
            }
            (ctx as any).skip();
            return;
          }
          throw err;
        }
      },
      timeout
    );
  },
  {
    skip: it.skip,
    only: it.only,
  }
);
