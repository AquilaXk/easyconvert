import fs from 'node:fs';
import path from 'node:path';

/**
 * Settings the worker writes into the user profile of one office suite run. The suite reads its settings from
 * `user/registrymodifications.xcu` of the profile named by `-env:UserInstallation`; a run in the worker's own temporary profile is
 * the only run these reach, never a pooled profile that other jobs share.
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
const KEEP_EXCEL_OBJECTS_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Filter/Microsoft/Import"><prop oor:name="ExcelToCalc" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`;

/** Writes the setting that keeps embedded Excel objects into the profile whose root is `profileRoot` (the directory named by `-env:UserInstallation`). */
export function writeKeepExcelObjectsSetting(profileRoot: string): void {
  const userDirectory = path.join(profileRoot, 'user');
  fs.mkdirSync(userDirectory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  fs.writeFileSync(path.join(userDirectory, 'registrymodifications.xcu'), KEEP_EXCEL_OBJECTS_SETTINGS, { mode: PROFILE_FILE_MODE });
}
