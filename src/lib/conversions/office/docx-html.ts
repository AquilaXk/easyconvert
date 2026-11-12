import { type DocxBlockElement, type DocxParagraph, type DocxTable } from './types';
import { escapeMarkupAttribute } from '../../text/escape';

export function generateHtmlFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  title: string,
  elements?: DocxBlockElement[]
): string {
  let body = '';

  const renderParagraph = (p: DocxParagraph): string => {
    let pContent = '';
    for (const r of (p.runs || [])) {
      let t = escapeMarkupAttribute(r.text);
      if (r.isBold) t = `<strong>${t}</strong>`;
      if (r.isItalic) t = `<em>${t}</em>`;
      if (r.isUnderline) t = `<u>${t}</u>`;
      if (r.isStrike) t = `<del>${t}</del>`;
      if (r.color) t = `<span style="color:#${r.color}">${t}</span>`;
      pContent += t;
    }
    if (!pContent) pContent = escapeMarkupAttribute(p.text);

    if (p.isHeading) {
      const hTag = `h${p.headingLevel || 2}`;
      return `<${hTag}>${pContent}</${hTag}>\n`;
    }
    if (p.isBullet) {
      return `<ul><li>${pContent}</li></ul>\n`;
    }
    const alignStyle = p.alignment ? ` style="text-align:${p.alignment}"` : '';
    return `<p${alignStyle}>${pContent}</p>\n`;
  };

  const renderTable = (tbl: DocxTable): string => {
    let tblStyle = 'border-collapse:collapse;margin:1.5rem 0;width:100%;';
    if (tbl.tblBorders) {
      if (tbl.tblBorders.top && tbl.tblBorders.top.style !== 'none') {
        tblStyle += `border-top:${tbl.tblBorders.top.size || 1}pt ${tbl.tblBorders.top.style || 'solid'} ${tbl.tblBorders.top.color || '#CCD2FC'};`;
      }
      if (tbl.tblBorders.bottom && tbl.tblBorders.bottom.style !== 'none') {
        tblStyle += `border-bottom:${tbl.tblBorders.bottom.size || 1}pt ${tbl.tblBorders.bottom.style || 'solid'} ${tbl.tblBorders.bottom.color || '#CCD2FC'};`;
      }
    }
    let tblHtml = `<table border="1" cellpadding="8" cellspacing="0" style="${tblStyle}">\n`;

    if (tbl.structuredRows && tbl.structuredRows.length > 0) {
      tbl.structuredRows.forEach((sRow, rIdx) => {
        tblHtml += '<tr>\n';
        sRow.forEach((cell) => {
          if (cell.rowSpan === 0) return; // Skip cells vertically merged from previous row
          const tag = cell.isHeader || rIdx === 0 ? 'th' : 'td';
          let cellStyle = 'padding:8px;text-align:left;';
          if (cell.shading && cell.shading !== 'auto') {
            cellStyle += `background-color:#${cell.shading};`;
          } else if (tag === 'th') {
            cellStyle += 'background:#F0F2FE;color:#1F2340;';
          }
          if (cell.borders) {
            if (cell.borders.top && cell.borders.top.style !== 'none') {
              cellStyle += `border-top:${cell.borders.top.size || 1}pt ${cell.borders.top.style || 'solid'} ${cell.borders.top.color || '#CCD2FC'};`;
            }
            if (cell.borders.bottom && cell.borders.bottom.style !== 'none') {
              cellStyle += `border-bottom:${cell.borders.bottom.size || 1}pt ${cell.borders.bottom.style || 'solid'} ${cell.borders.bottom.color || '#CCD2FC'};`;
            }
            if (cell.borders.left && cell.borders.left.style !== 'none') {
              cellStyle += `border-left:${cell.borders.left.size || 1}pt ${cell.borders.left.style || 'solid'} ${cell.borders.left.color || '#CCD2FC'};`;
            }
            if (cell.borders.right && cell.borders.right.style !== 'none') {
              cellStyle += `border-right:${cell.borders.right.size || 1}pt ${cell.borders.right.style || 'solid'} ${cell.borders.right.color || '#CCD2FC'};`;
            }
          } else {
            cellStyle += 'border:1px solid #E1E4EE;';
          }
          const colSpanAttr = cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
          const rowSpanAttr = cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
          let cellInner = escapeMarkupAttribute(cell.text).replace(/\n/g, '<br/>');
          if (cell.nestedTable) {
            cellInner += (cellInner ? '<br/>' : '') + renderTable(cell.nestedTable);
          }
          tblHtml += `  <${tag}${colSpanAttr}${rowSpanAttr} style="${cellStyle}">${cellInner}</${tag}>\n`;
        });
        tblHtml += '</tr>\n';
      });
    } else {
      tbl.rows.forEach((row, rIdx) => {
        tblHtml += '<tr>\n';
        row.forEach((cell) => {
          if (rIdx === 0) {
            tblHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeMarkupAttribute(cell)}</th>\n`;
          } else {
            tblHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeMarkupAttribute(cell)}</td>\n`;
          }
        });
        tblHtml += '</tr>\n';
      });
    }
    tblHtml += '</table>\n';
    return tblHtml;
  };

  if (elements && elements.length > 0) {
    for (const el of elements) {
      if (el.type === 'paragraph') body += renderParagraph(el.paragraph);
      else if (el.type === 'table') body += renderTable(el.table);
      else if (el.type === 'drawing') body += `<div class="vector-drawing" style="margin:1.5rem 0;">${el.svg}</div>\n`;
    }
  } else {
    for (const p of paragraphs) body += renderParagraph(p);
    for (const tbl of tables) body += renderTable(tbl);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:850px;margin:2rem auto;padding:0 1.5rem;color:#1F2340;}h1,h2,h3{color:#5C6BC0;}</style></head><body><h1>${escapeMarkupAttribute(
    title
  )}</h1>${body}</body></html>`;
}

export function generateMarkdownFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  elements?: DocxBlockElement[]
): string {
  const parts: string[] = [];

  const renderParagraph = (p: DocxParagraph): string => {
    if (p.isHeading) {
      const hashes = '#'.repeat(p.headingLevel || 2);
      return `${hashes} ${p.text}`;
    }
    if (p.isBullet) {
      return `- ${p.text}`;
    }
    let t = '';
    for (const r of (p.runs || [])) {
      let rText = r.text;
      if (r.isBold) rText = `**${rText}**`;
      if (r.isItalic) rText = `*${rText}*`;
      if (r.isStrike) rText = `~~${rText}~~`;
      t += rText;
    }
    return t || p.text;
  };

  const renderTable = (tbl: DocxTable): string => {
    if (tbl.rows.length === 0) return '';
    const cleanRows = tbl.rows.map((r) =>
      r.map((c) => c.replace(/\n/g, ' ').replace(/\|/g, '\\|'))
    );
    const header = `| ${cleanRows[0].join(' | ')} |`;
    const sep = `| ${cleanRows[0].map(() => '---').join(' | ')} |`;
    const body = cleanRows
      .slice(1)
      .map((r) => `| ${r.join(' | ')} |`)
      .join('\n');
    return `${header}\n${sep}\n${body}`;
  };

  if (elements && elements.length > 0) {
    for (const el of elements) {
      if (el.type === 'paragraph') parts.push(renderParagraph(el.paragraph));
      else if (el.type === 'table') parts.push(renderTable(el.table));
      else if (el.type === 'drawing' && el.shapes) {
        const shapeTexts = el.shapes.map((s) => s.text).filter(Boolean);
        if (shapeTexts.length > 0) {
          parts.push(shapeTexts.map((t) => `> **[Drawing]** ${t}`).join('\n'));
        }
      }
    }
  } else {
    for (const p of paragraphs) parts.push(renderParagraph(p));
    for (const tbl of tables) parts.push(renderTable(tbl));
  }

  return parts.join('\n\n');
}
