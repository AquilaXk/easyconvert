/**
 * Turns the served OpenAPI document into the one the SDK generators read. The served document stays as it is: the changes below only
 * exist because neither generator resolves what the document does on purpose.
 *
 * 1. Operations marked `x-internal` serve the web application, not the public contract, and get no client method.
 * 2. Component schemas name themselves with an absolute `$id` and refer to each other by it. Neither generator fetches
 *    `https://easyconvert.local/...`, so each such reference becomes a local `#/components/schemas/<name>` one and `$id` is dropped.
 * 3. `ConversionOptions` has inline enums that the Python generator names after their property alone, so `audioChannels` (a layout
 *    name) and `audio.channels` (a count) collide and it drops the schema. Each enum moves to its own component schema.
 * 4. A header parameter schema with `const` (`Tus-Resumable: 1.0.0`) loses the `const`: the Python generator rejects a literal in a
 *    header and would drop the four upload operations. The description names the value.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const SCHEMA_REF_PREFIX = '#/components/schemas/';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: Json | undefined, where: string): JsonObject {
  if (!isObject(value)) throw new Error(`OpenAPI document has no object at ${where}`);
  return value;
}

function dropInternalOperations(paths: JsonObject): JsonObject {
  const kept: JsonObject = {};
  for (const [route, item] of Object.entries(paths)) {
    const pathItem = requireObject(item, route);
    const publicEntries = Object.entries(pathItem).filter(([key, operation]) => {
      return !HTTP_METHODS.includes(key) || !(isObject(operation) && operation['x-internal'] === true);
    });
    if (publicEntries.some(([key]) => HTTP_METHODS.includes(key))) kept[route] = Object.fromEntries(publicEntries);
  }
  return kept;
}

function dropHeaderConst(node: Json): void {
  if (Array.isArray(node)) {
    node.forEach(dropHeaderConst);
    return;
  }
  if (!isObject(node)) return;
  if (node.in === 'header' && isObject(node.schema)) delete node.schema.const;
  Object.values(node).forEach(dropHeaderConst);
}

function schemaIdToName(schemas: JsonObject): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (isObject(schema) && typeof schema.$id === 'string') names.set(schema.$id, name);
  }
  return names;
}

function localizeRefs(node: Json, names: Map<string, string>): Json {
  if (Array.isArray(node)) return node.map((child) => localizeRefs(child, names));
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$id') continue;
    const name = key === '$ref' && typeof value === 'string' ? names.get(value) : undefined;
    out[key] = name === undefined ? localizeRefs(value, names) : SCHEMA_REF_PREFIX + name;
  }
  return out;
}

function pascalCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Moves every inline enum property of an options schema, at any depth, into `components.schemas` and leaves a reference behind. The
 * component is named leaf first and then its parents (`ChannelsOfAudio`), so `audioChannels` and `audio.channels` do not collide.
 */
function hoistInlineEnums(schemas: JsonObject, owner: JsonObject, parents: readonly string[]): void {
  const properties = owner.properties;
  if (!isObject(properties)) return;
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) continue;
    if (Array.isArray(property.enum)) {
      const componentName = [name, ...parents].map(pascalCase).join('Of');
      schemas[componentName] = property;
      properties[name] = { $ref: SCHEMA_REF_PREFIX + componentName };
    } else {
      hoistInlineEnums(schemas, property, [name, ...parents]);
    }
  }
}

export function normalizeOpenApiForSdk(document: object): object {
  const source = requireObject(JSON.parse(JSON.stringify(document)) as Json, 'document');
  const components = requireObject(source.components, 'components');
  const names = schemaIdToName(requireObject(components.schemas, 'components.schemas'));
  const localized = requireObject(
    localizeRefs({ ...source, paths: dropInternalOperations(requireObject(source.paths, 'paths')) }, names),
    'document',
  );
  const localizedSchemas = requireObject(requireObject(localized.components, 'components').schemas, 'components.schemas');
  hoistInlineEnums(localizedSchemas, requireObject(localizedSchemas.ConversionOptions, 'components.schemas.ConversionOptions'), []);
  dropHeaderConst(localized);
  return localized;
}
