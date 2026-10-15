import { levenshtein } from './ocr-cer';

/**
 * Tree-edit-distance based table similarity (TEDS, Zhong et al. 2020) for tables as rows of cell texts, written from the
 * paper's definition with the Zhang-Shasha algorithm for ordered trees. A table is the tree table -> tr -> td; inserting
 * or deleting a node costs 1, relabelling a td costs the normalised edit distance of the two texts, relabelling
 * anything else to a different tag costs 1. TEDS = 1 - distance / the larger node count.
 */

interface TreeNode {
  tag: 'table' | 'tr' | 'td';
  text: string;
  children: TreeNode[];
}

function treeOf(rows: string[][]): TreeNode {
  return {
    tag: 'table',
    text: '',
    children: rows.map((row) => ({ tag: 'tr', text: '', children: row.map((cell): TreeNode => ({ tag: 'td', text: cell.trim(), children: [] })) })),
  };
}

function sizeOf(node: TreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + sizeOf(child), 0);
}

interface Indexed {
  /** Post-order labels. */
  nodes: TreeNode[];
  /** Index (post-order) of the leftmost leaf descendant of each node. */
  leftmost: number[];
  keyroots: number[];
}

function index(root: TreeNode): Indexed {
  const nodes: TreeNode[] = [];
  const leftmost: number[] = [];
  const visit = (node: TreeNode): number => {
    let first = -1;
    node.children.forEach((child, i) => {
      const childLeft = visit(child);
      if (i === 0) first = childLeft;
    });
    nodes.push(node);
    const at = nodes.length - 1;
    leftmost[at] = node.children.length === 0 ? at : first;
    return leftmost[at];
  };
  visit(root);
  const seen = new Set<number>();
  const keyroots: number[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!seen.has(leftmost[i])) {
      seen.add(leftmost[i]);
      keyroots.push(i);
    }
  }
  return { nodes, leftmost, keyroots: keyroots.sort((a, b) => a - b) };
}

function relabelCost(a: TreeNode, b: TreeNode): number {
  if (a.tag !== b.tag) return 1;
  if (a.tag !== 'td') return 0;
  const longest = Math.max(a.text.length, b.text.length);
  return longest === 0 ? 0 : levenshtein(a.text, b.text) / longest;
}

function treeDistance(left: TreeNode, right: TreeNode): number {
  const a = index(left);
  const b = index(right);
  const n = a.nodes.length;
  const m = b.nodes.length;
  const distance = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (const i of a.keyroots) {
    for (const j of b.keyroots) {
      const li = a.leftmost[i];
      const lj = b.leftmost[j];
      const rows = i - li + 2;
      const cols = j - lj + 2;
      const forest = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
      for (let x = 1; x < rows; x++) forest[x][0] = forest[x - 1][0] + 1;
      for (let y = 1; y < cols; y++) forest[0][y] = forest[0][y - 1] + 1;
      for (let x = 1; x < rows; x++) {
        for (let y = 1; y < cols; y++) {
          const ai = li + x - 1;
          const bj = lj + y - 1;
          if (a.leftmost[ai] === li && b.leftmost[bj] === lj) {
            forest[x][y] = Math.min(forest[x - 1][y] + 1, forest[x][y - 1] + 1, forest[x - 1][y - 1] + relabelCost(a.nodes[ai], b.nodes[bj]));
            distance[ai][bj] = forest[x][y];
          } else {
            const px = a.leftmost[ai] - li;
            const py = b.leftmost[bj] - lj;
            forest[x][y] = Math.min(forest[x - 1][y] + 1, forest[x][y - 1] + 1, forest[px][py] + distance[ai][bj]);
          }
        }
      }
    }
  }
  return distance[n - 1][m - 1];
}

/** TEDS of a predicted table against a reference, in 0..1. */
export function teds(reference: string[][], predicted: string[][]): number {
  const left = treeOf(reference);
  const right = treeOf(predicted);
  return Math.max(0, 1 - treeDistance(left, right) / Math.max(sizeOf(left), sizeOf(right)));
}
