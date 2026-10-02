import checks from "./checks.json";
import { parseCheckDefinitions, suiteTitle, type UploadOption } from "./select";

const definitions = parseCheckDefinitions(checks);

/** The title for `option`'s suite, tagged with the decision version that chose it. */
export function titleFor(option: UploadOption): string {
  const [suite, ...others] = definitions.suites.filter((s) => s.option === option);
  if (suite === undefined) throw new Error(`checks.json has no suite for option ${option}.`);
  if (others.length > 0) throw new Error(`checks.json has several suites for option ${option}.`);
  return suiteTitle(definitions, suite);
}
