import {Term, Grammar, termTable} from "./grammar/grammar"
import {State, Shift, Reduce} from "./grammar/automaton"

const BADNESS_DELETE = 100, BADNESS_RECOVER = 100
const BADNESS_STABILIZING = 50, BADNESS_WILD = 150 // Limits in between which stacks are less agressively pruned

// (FIXME: this will go out of date before I know it, revisit at some
// point)
//
// Badness is a measure of how off-the-rails a given parse is. It is
// bumped when a recovery strategy is applied, and then reduced (by
// multiplication with a constant < 1) for every successful (real)
// token shifted.
//
// Stacks with a low badness are relatively credible parses that have
// shift matching the input in their recent history. Stacks with a
// high badness are deeply in the weeds and likely wrong. For each of
// these, we prune agressively by dropping stacks when another stack
// at the same position is looking better.
//
// For those in the BADNESS_STABILIZING - BADNESS_WILD range, we
// assume that they are in the process of trying to recover and allow
// a bunch of them to continue alongside each other to see which one
// works out better.
//
// Stacks with the same low badness score are likely to be valid GLR
// parsing branches, so in that case it's often a good idea to let
// both continue.
//
// When a stack fails to find an advancing action, recovery is only
// applied when its badness is < BADNESS_WILD, or no better parse
// exists at that point.

class Stack {
  constructor(readonly grammar: Grammar,
              public stack: number[], // Holds state, pos, node count triplets
              public values: (Node | number[])[],
              public badness: number) {}

  get state() { return this.grammar.table[this.stack[this.stack.length - 3]] }

  get pos() { return this.stack[this.stack.length - 2] }

  get nodeCount() { return this.stack[this.stack.length - 1] }

  toString() {
    return "[" + this.stack.filter((_, i) => i % 3 == 0).join(",") + "] " +
      this.values.map(v => v instanceof Node ? v : NodeBuffer.build(v, 0, 0)).join(",")
  }

  static start(grammar: Grammar) {
    return new Stack(grammar, [0, 0, 0], [[]], 0)
  }

  reduceValue(name: Term, childCount: number, start: number) {
    let children: (Node | NodeBuffer)[] = [], positions: number[] = []
    for (let remaining = childCount;;) {
      let value = this.values.pop()!
      if (value instanceof Node) {
        children.push(value)
        let countHere = this.nodeCount - childCount + remaining
        for (let i = this.stack.length - 1;; i -= 3) {
          if (this.stack[i] == countHere) { positions.push(this.stack[i - 1] - start); break }
        }
        remaining -= value.size
        if (remaining == 0) break
      } else { // A buffer
        let size = value.length >> 2, startIndex = Math.max(0, (size - remaining) << 2)
        if (startIndex < value.length) {
          let nodeStart = value[startIndex + 1]
          children.push(NodeBuffer.build(value, startIndex, nodeStart))
          positions.push(nodeStart)
        }
        remaining -= size
        if (remaining <= 0) {
          value.length = startIndex
          this.values.push(value)
          break
        }
      }
    }
    this.values.push(new Node(name, this.pos - start, childCount, children, positions))
  }

  reduce(depth: number, name: Term) {
    let {pos, nodeCount} = this
    if (depth) {
      let newLen = this.stack.length - (depth * 3)
      let start = this.stack[newLen - 2], count = nodeCount - this.stack[newLen - 1]
      if (name.tag) {
        let last = this.values[this.values.length - 1]
        if (Array.isArray(last) && last.length >= count) {
          last.push(name.id, start, pos, count)
        } else
          this.reduceValue(name, count, start)
        nodeCount++
      }
      this.stack.length = newLen
    }
    this.stack.push(this.state.getGoto(name)!.target.id, pos, nodeCount)
  }

  shiftValue(term: Term, start: number, end: number, count = 0) {
    let last = this.values[this.values.length - 1]
    if (!Array.isArray(last)) this.values.push(last = [])
    if (term.error && last.length && last[last.length - 4] == term.id &&
        (start == end || last[last.length - 3] == start)) return
    last.push(term.id, start, end, count)
    this.stack[this.stack.length - 1]++
  }

  apply(action: Shift | Reduce, next: Term, nextStart: number, nextEnd: number) {
    if (action instanceof Reduce) {
      this.reduce(action.rule.parts.length, action.rule.name)
    } else { // Shift
      this.stack[this.stack.length - 2] = nextStart
      this.stack.push(action.target.id, nextEnd, this.nodeCount)
      if (next.tag) this.shiftValue(next, nextStart, nextEnd)
      this.badness = (this.badness >> 1) + (this.badness >> 2) // (* 0.75)
    }
  }

  useCached(value: Node, start: number, next: State) {
    this.stack.push(next.id, start + value.length /* FIXME */, this.nodeCount + value.size)
    this.values.push(value)
    this.badness >> 1 // FIXME
  }

  split() {
    return new Stack(this.grammar, this.stack.slice(), this.values.map(v => Array.isArray(v) ? v.slice() : v), this.badness)
  }

  recoverByDelete(next: Term, nextStart: number, nextEnd: number, verbose: boolean) {
    if (next.tag) this.shiftValue(next, nextStart, nextEnd)
    // FIXME merge errors?
    this.shiftValue(this.grammar.terms.error, nextStart, nextEnd, next.tag ? 1 : 0)
    this.stack[this.stack.length - 2] = nextEnd
    this.badness += BADNESS_DELETE
    if (verbose) console.log("delete token " + next + ": " + this, nextStart, nextEnd)
  }

  canRecover(next: Term) {
    // Scan for a state that has either a direct action or a recovery
    // action for next, without actually building up a new stack
    for (let top = this.state, rest = this.stack, offset = rest.length - 3;;) {
      if (top.terminals.some(a => a.term == next) ||
          top.recover.some(a => a.term == next)) return true
      // Find a way to reduce from here
      let term, n
      let direct = top.terminals.find(a => a instanceof Reduce) as Reduce, pos
      if (direct) {
        term = direct.rule.name
        n = direct.rule.parts.length
      } else if (pos = top.set.find(p => p.pos > 0)) { // FIXME store this in the run-time states
        term = pos.rule.name
        n = pos.pos
      } else {
        return false
      }
      if (n == 0) { // FIXME
        rest = rest.slice()
        rest.push(top.id, 0, 0)
        offset += 3
      } else {
        offset -= (n - 1) * 3
      }
      let goto = this.grammar.table[rest[offset - 3]].getGoto(term)
      if (!goto) return false
      top = goto.target
    }
  }

  recoverByInsert(next: Term, nextStart: number, nextEnd: number, verbose: boolean): Stack | null {
    if (!this.canRecover(next)) return null
    // Now that we know there's a recovery to be found, run the
    // reduces again, the expensive way, updating the stack

    let result = this.split()
    result.badness += BADNESS_RECOVER
    for (;;) {
      for (;;) {
        if (result.state.terminals.some(a => a.term == next)) {
          if (verbose) console.log("recovered to " + result)
          return result
        }
        let recover = result.state.recover.find(a => a.term == next)
        if (!recover) break
        if (verbose) console.log("skip from state " + result.state.id + " to " + recover.target.id)
        let pos = result.pos
        result.stack.push(recover.target.id, pos, result.nodeCount)
        result.shiftValue(this.grammar.terms.error, pos, pos)
      }
      
      let direct = result.state.terminals.find(a => a instanceof Reduce) as Reduce, pos
      if (direct) {
        result.reduce(direct.rule.parts.length, direct.rule.name)
      } else if (pos = result.state.set.find(p => p.pos > 0)) {
        // Force a reduce using this position
        result.shiftValue(this.grammar.terms.error, result.pos, result.pos)
        result.reduce(pos.pos, pos.rule.name)
      }
    }
  }
}

import {takeFromHeap, addToHeap} from "./heap"

function compareStacks(a: Stack, b: Stack) { return a.pos - b.pos }

function addStack(heap: Stack[], stack: Stack, strict = stack.badness < BADNESS_STABILIZING || stack.badness > BADNESS_WILD): boolean {
  for (let i = 0; i < heap.length; i++) {
    let other = heap[i]
    if ((strict || other.state == stack.state) && other.pos == stack.pos) {
      let diff = stack.badness - other.badness || (stack.badness < BADNESS_STABILIZING ? 0 : stack.stack.length - other.stack.length)
      if (diff < 0) { heap[i] = stack; return true }
      else if (diff > 0) return false
    }
  }
  addToHeap(heap, stack, compareStacks)
  return true
}

export class Node {
  constructor(readonly name: Term | null,
              readonly length: number,
              readonly size: number,
              readonly children: (Node | NodeBuffer)[],
              readonly positions: number[]) {}

  toString() {
    return this.name ? (this.children.length ? this.name.tag + "(" + this.children + ")" : this.name.tag!) : this.children.join()
  }

/* FIXME restore
  partial(start: number, end: number, offset: number, target: Node) {
    if (start <= 0 && end >= this.length) {
      target.children.push(this)
      target.positions.push(offset)
    } else {
      for (let i = 0; i < this.children.length; i++) {
        let from = this.positions[i]
        if (from >= end) break
        let child = this.children[i], to = from + child.length
        if (to > start) child.partial(start - from, end - from, offset + from, target)
      }
    }
  }*/
}

//const MAX_BUFFER = 8192

// Node buffers contain type,start,end,childCount quads for each node. The
// nodes are built in postfix order (with parent nodes being written
// after child nodes), but converted to prefix order when wrapped in a
// NodeBuffer.
export class NodeBuffer {
  constructor(readonly buffer: Uint16Array) {}

  get size() { return this.buffer.length >> 2 }

  static build(source: number[], start: number, offset: number) {
    let buffer = new Uint16Array(source.length - start)
    let i = buffer.length, pos = source.length
    function build() {
      let count = source[--pos], to = source[--pos], from = source[--pos], tag = source[--pos]
      let toPos = pos - (count << 2)
      while (pos > toPos) build()
      buffer[--i] = count; buffer[--i] = to; buffer[--i] = from; buffer[--i] = tag
    }
    while (pos > start) build()
    return new NodeBuffer(buffer)
  }

  toString() {
    let pos = 0
    let next = () => {
      let tag = this.buffer[pos], count = this.buffer[pos+3]
      pos += 4
      let children = "", end = pos + (count << 2)
      while (pos < end) children += (children ? "," : "") + next()
      return termTable[tag].tag! + (children ? "(" + children + ")" : "")
    }
    let result = ""
    while (pos < this.buffer.length) result += (result ? "," : "") + next()
    return result
  }
}

/*
class TreeCursor {
  nodes: Node[]
  start = [0]
  index = [0]

  constructor(node: Node) { this.nodes = [node] }

  // `pos` must be >= any previously given `pos` for this cursor
  nodeAt(pos: number) {
    for (;;) {
      let last = this.nodes.length - 1
      if (last < 0) return null
      let top = this.nodes[last], index = this.index[last]
      if (index == top.children.length) {
        this.nodes.pop()
        this.start.pop()
        this.index.pop()
        continue
      }
      let next = top.children[index]
      let start = this.start[last] + top.positions[index]
      if (start >= pos) return start == pos ? next : null
      this.index[last]++
      if (start + next.length >= pos) { // Enter this node
        this.nodes.push(next)
        this.start.push(start)
        this.index.push(0)
      }
    }
  }
}
*/

export function parse(input: string, grammar: Grammar, cache = null, verbose = false, strict = false): Node {
  let parses = [Stack.start(grammar)]
//  let cacheIter = new TreeCursor(cache)

  function advance(stack: Stack, next: Term, nextStart: number, nextEnd: number) {
    let used = false
    for (let i = 0, actions = stack.state.terminals; i < actions.length; i++) {
      let action = actions[i]
      if (action.term != next) continue
      let local = stack
      for (let j = i + 1; j < actions.length; j++) if (actions[j].term == next) {
        local = stack.split()
        break
      }
      used = true
      local.apply(action, next, nextStart, nextEnd)
      if (verbose) console.log(`${local} (via ${next} ${action})`, input.slice(nextStart, nextEnd))
      addStack(parses, local, action instanceof Shift)
    }
    return used
  }

  parse: for (;;) {
    let stack = takeFromHeap(parses, compareStacks)

/*    if (!stack.state.ambiguous) { // FIXME this isn't robust
      for (let cached = cacheIter.nodeAt(stack.pos); cached;
           cached = cached.children.length && cached.positions[0] == 0 ? cached.children[0] : null) {
        let match = stack.state.getGoto(cached.name!)
        if (match) {
          stack.useCached(cached, match.target)
          addStack(parses, stack)
          continue parse
        }
      }
    }*/

    let token: Term | null = null, start = stack.pos, end = start, sawEof = false
    let maxStart = start
    // FIXME cache token info
    for (let tokenCx of grammar.tokenTable[stack.state.id]) {
      let curPos = stack.pos
      if (tokenCx.skip) {
        let skip = tokenCx.skip.simulate(input, curPos)
        if (skip) { curPos = skip.end; maxStart = Math.max(maxStart, skip.end) }
      }
      if (curPos == input.length) {
        if (sawEof) continue
        sawEof = true
        token = grammar.terms.eof
        start = end = curPos
      } else {
        let found = tokenCx.tokens.simulate(input, curPos)
        if (!found) continue
        start = curPos
        end = found.end
        token = found.term
        let specialized = grammar.specialized[token.name]
        if (specialized) {
          let value = specialized[input.slice(start, end)]
          if (value && advance(stack, value, start, end)) continue parse
        }
      }
      if (advance(stack, token, start, end)) continue parse // FIXME allow advancement via multiple tokens?
    }

    // If we're here, the stack failed to advance

    if (maxStart == input.length) {
      if (stack.stack.length != 6) stack.reduce(stack.stack.length / 3 - 1, grammar.terms.error)
      let value = stack.values[0]
      return Array.isArray(value) ? NodeBuffer.build(value, 0, 0) as any as Node : value
    }

    if (!strict &&
        !(stack.badness > BADNESS_WILD && parses.some(s => s.pos >= stack.pos && s.badness <= stack.badness))) {
      if (!token) {
        token = maxStart == input.length ? grammar.terms.eof : grammar.terms.error
        start = maxStart
        end = start + (maxStart == input.length ? 0 : 1)
      }

      let inserted = stack.recoverByInsert(token, start, end, verbose)
      if (inserted) addStack(parses, inserted)
      stack.recoverByDelete(token, start, end, verbose)
      addStack(parses, stack)
    }
    if (!parses.length)
      throw new SyntaxError("No parse at " + start + " with " + token + " (stack is " + stack + ")")
  }
}
