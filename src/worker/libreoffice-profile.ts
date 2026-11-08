import fs from 'node:fs';
import path from 'node:path';

/**
 * Settings the worker writes into the user profile of every office suite run. The suite reads its settings from
 * `user/registrymodifications.xcu` of the profile named by `-env:UserInstallation`. Every profile the worker names (a run's own
 * temporary profile, the profile of a pool slot, the profile of the readiness probe and of the PDF/A conversion) is written before the
 * suite starts, so a document never meets the suite's defaults.
 */

const PROFILE_FILE_MODE = 0o600;
const PROFILE_DIRECTORY_MODE = 0o700;

/**
 * Leaves the Excel objects a Microsoft document embeds (charts and worksheets, `Excel.Chart.8`, `Excel.Sheet.8`, `Excel.Sheet.5`) as
 * the objects they are, shown by the picture the document carries for them. The default converts each to a Calc object on import
 * (`filter/source/msfilter/msdffimp.cxx` `CheckForConvertToSOObj`, lines 7121 to 7145, which reads the option as `OLE_EXCEL_2_STARCALC`
 * from `sd/source/filter/ppt/pptin.cxx` lines 205 and 206): a chart whose series name whole columns then gets an internal data table of
 * 1,048,578 rows, which is 770 MB of `content.xml` for each of two charts of `govdocs1-001020.ppt`.
 */
/**
 * The settings every run gets, whatever the document. The names and values are those of the suite's configuration schema
 * (`registry/main.xcd`, `registry/calc.xcd` and `registry/writer.xcd` of the installation), whose Administrator's Guide documents them:
 *
 *  - `Common/Security/Scripting`: `MacroSecurityLevel` 3 is "very high" (only macros of a trusted location run; none is trusted),
 *    `DisableMacrosExecution` turns macro execution off altogether, `DisableActiveContent` also stops the other active content of a
 *    document (scripts, and the links that carry a script), and `BlockUntrustedRefererLinks` refuses a link a document opens from an
 *    untrusted place. A conversion has no use for any of them: the macros of a document are never wanted, and the input has them
 *    removed by content before it gets here (`officeInputWithoutMacros`); this is the second lock on the same door.
 *  - `Calc/Content/Update` `Link` 2 and `Writer/Content/Update` `Link` 2 are "never" for "update links when loading": the suite does not
 *    open the file or address an external reference, a DDE link or a linked section names, so the content of a file on the worker, or of
 *    a place on a network, never reaches the output through a link. The schema's own default is "on request", which a headless run
 *    answers by itself.
 */
const SECURITY_SETTINGS = `<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
`;

/**
 * Leaves the Excel objects a Microsoft document embeds (charts and worksheets, `Excel.Chart.8`, `Excel.Sheet.8`, `Excel.Sheet.5`) as
 * the objects they are, shown by the picture the document carries for them. The default converts each to a Calc object on import
 * (`filter/source/msfilter/msdffimp.cxx` `CheckForConvertToSOObj`, lines 7121 to 7145, which reads the option as `OLE_EXCEL_2_STARCALC`
 * from `sd/source/filter/ppt/pptin.cxx` lines 205 and 206): a chart whose series name whole columns then gets an internal data table of
 * 1,048,578 rows, which is 770 MB of `content.xml` for each of two charts of `govdocs1-001020.ppt`.
 */
const KEEP_EXCEL_OBJECTS_SETTING = `<item oor:path="/org.openoffice.Office.Common/Filter/Microsoft/Import"><prop oor:name="ExcelToCalc" oor:op="fuse"><value>false</value></prop></item>
`;

export interface OfficeProfileOptions {
  /** Leave the Excel objects of a Microsoft document as they are (`KEEP_EXCEL_OBJECTS_SETTING`). */
  keepEmbeddedExcelObjects?: boolean;
}

/**
 * Writes the profile whose root is `profileRoot` (the directory named by `-env:UserInstallation`): the fixed settings of every run, and the
 * ones the options ask for. Written before the suite starts, over whatever the root holds.
 */
export function writeOfficeProfile(profileRoot: string, options: OfficeProfileOptions = {}): void {
  const items = SECURITY_SETTINGS + (options.keepEmbeddedExcelObjects ? KEEP_EXCEL_OBJECTS_SETTING : '');
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${items}</oor:items>
`;
  const userDirectory = path.join(profileRoot, 'user');
  fs.mkdirSync(userDirectory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  fs.writeFileSync(path.join(userDirectory, 'registrymodifications.xcu'), settings, { mode: PROFILE_FILE_MODE });
}

/** Writes the profile of a run that keeps the Excel objects a Microsoft document embeds (see `writeOfficeProfile`). */
export function writeKeepExcelObjectsSetting(profileRoot: string): void {
  writeOfficeProfile(profileRoot, { keepEmbeddedExcelObjects: true });
}
