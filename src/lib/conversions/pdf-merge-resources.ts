/*
 * The merge of two resource dictionaries, translated from qpdf (https://github.com/qpdf/qpdf), tag v12.4.2, commit
 * 4eba95899886e851cc41d76886483b347612f2a8 (Apache-2.0, Copyright (c) 2005-2021 Jay Berkenbilt, 2022-2026 Jay Berkenbilt and Manfred Holger), file libqpdf/QPDFObjectHandle.cc (SHA-256 c19ecec9...47e43a):
 * `QPDFObjectHandle::makeResourcesIndirect`, `mergeResources`, `getResourceNames` and `getUniqueResourceName`.
 *
 * The structure, the names (in camelCase), the branches and the comments are qpdf's. A qpdf handle knows whether it is indirect; here a
 * value is indirect when the dictionary holds a reference to it. Resource and key names are written without their slashes.
 * Changes for this repository are in other files and other commits, each with its reason in its message.
 */
import { PDFArray, PDFDict, PDFNull, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import type { ResourceRenames } from './pdf-merge-content-names';
import { dictAt, name, shallowCopy } from './pdf-merge-objects';

const isNull = (context: PDFContext, value: PDFObject | undefined): boolean => {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved === undefined || resolved === PDFNull;
};

/** `QPDFObjectHandle::makeResourcesIndirect`: every entry of every resource subdictionary becomes an indirect object. */
export function makeResourcesIndirect(context: PDFContext, resources: PDFDict): void {
  for (const [, value] of resources.entries()) {
    const subdictionary = dictAt(context, value);
    if (!subdictionary) continue;
    for (const [key, entry] of subdictionary.entries()) {
      if (!isNull(context, entry) && !(entry instanceof PDFRef)) subdictionary.set(key, context.register(entry));
    }
  }
}

/** `QPDFObjectHandle::getResourceNames`: the second-level keys of the resource dictionary. */
export function getResourceNames(context: PDFContext, resources: PDFDict): Set<string> {
  const result = new Set<string>();
  for (const [, value] of resources.entries()) {
    const subdictionary = dictAt(context, value);
    if (!subdictionary) continue;
    for (const [key, entry] of subdictionary.entries()) {
      if (!isNull(context, entry)) result.add(key.decodeText());
    }
  }
  return result;
}

/** `QPDFObjectHandle::getUniqueResourceName`; `minSuffix.value` is the first suffix tried and holds the one used on return. */
function getUniqueResourceName(prefix: string, minSuffix: { value: number }, names: Set<string>): string {
  const maxSuffix = minSuffix.value + names.size;
  while (minSuffix.value <= maxSuffix) {
    const candidate = prefix + String(minSuffix.value);
    if (!names.has(candidate)) return candidate;
    // Increment after return; minSuffix should be the value used, not the next value.
    minSuffix.value += 1;
  }
  // This could only happen if there is a coding error. The number of candidates we test is more than the number of keys we're checking against.
  throw new Error('unable to find unconflicting name in getUniqueResourceName');
}

/** The name of each indirect entry of a resource subdictionary, by object: `make_og_to_name`. */
function nameByObject(context: PDFContext, dict: PDFDict): Map<string, string> {
  const ogToName = new Map<string, string>();
  for (const [key, value] of dict.entries()) {
    if (value instanceof PDFRef && !isNull(context, value)) ogToName.set(value.tag, key.decodeText());
  }
  return ogToName;
}

function mergeSubdictionary(context: PDFContext, owner: PDFDict, resourceType: string, thisValue: PDFDict, otherValue: PDFDict, conflicts?: ResourceRenames): void {
  let target = thisValue;
  if (owner.get(name(resourceType)) instanceof PDFRef) {
    // Do this even if there are no keys. Various places in the code call mergeResources with resource dictionaries that contain empty
    // subdictionaries just to get this shallow copy functionality.
    target = shallowCopy(context, thisValue) as PDFDict;
    owner.set(name(resourceType), target);
  }
  let ogToName = new Map<string, string>();
  let rnames = new Set<string>();
  const minSuffix = { value: 1 };
  let initializedMaps = false;
  for (const [keyName, value] of otherValue.entries()) {
    const key = keyName.decodeText();
    if (!target.has(keyName)) {
      target.set(keyName, value instanceof PDFRef ? value : shallowCopy(context, value));
    } else if (conflicts) {
      if (!initializedMaps) {
        ogToName = nameByObject(context, target);
        rnames = getResourceNames(context, owner);
        initializedMaps = true;
      }
      const reused = value instanceof PDFRef ? ogToName.get(value.tag) : undefined;
      const renamesOfType = conflicts.get(resourceType) ?? new Map<string, string>();
      if (reused !== undefined) {
        if (reused !== key) renamesOfType.set(key, reused);
      } else {
        const newKey = getUniqueResourceName(`${key}_`, minSuffix, rnames);
        renamesOfType.set(key, newKey);
        target.set(name(newKey), value);
      }
      if (renamesOfType.size > 0) conflicts.set(resourceType, renamesOfType);
    }
  }
}

function mergeArrays(context: PDFContext, thisValue: PDFArray, otherValue: PDFArray): void {
  const isScalar = (item: PDFObject): boolean => {
    const resolved = context.lookup(item);
    return !(resolved instanceof PDFDict || resolved instanceof PDFArray || resolved instanceof PDFStream);
  };
  const scalars = new Set<string>();
  for (let at = 0; at < thisValue.size(); at += 1) {
    const item = thisValue.get(at);
    if (isScalar(item)) scalars.add(item.toString());
  }
  for (let at = 0; at < otherValue.size(); at += 1) {
    const item = otherValue.get(at);
    if (isScalar(item) && !scalars.has(item.toString())) thisValue.push(item);
  }
}

/**
 * `QPDFObjectHandle::mergeResources`: merges the resource dictionary `other` into `resources`. A resource of `other` whose name `resources`
 * has for another object is added under a new name (`name_1`, `name_2`, ...), and `conflicts` records the new name by old name and type.
 */
export function mergeResources(context: PDFContext, resources: PDFDict, other: PDFDict, conflicts?: ResourceRenames): void {
  for (const [typeName, otherEntry] of other.entries()) {
    const resourceType = typeName.decodeText();
    const otherValue = context.lookup(otherEntry);
    if (resources.has(typeName)) {
      const thisValue = context.lookup(resources.get(typeName));
      if (thisValue instanceof PDFDict && otherValue instanceof PDFDict) {
        mergeSubdictionary(context, resources, resourceType, thisValue, otherValue, conflicts);
      } else if (thisValue instanceof PDFArray && otherValue instanceof PDFArray) {
        mergeArrays(context, thisValue, otherValue);
      }
    } else if (otherValue) {
      resources.set(typeName, shallowCopy(context, otherValue));
    }
  }
}
