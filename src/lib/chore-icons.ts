/**
 * chore-icons.ts — pictures for chores, so kids who can't read yet know what
 * each one is. A chore stores the key; the hub only checks its shape.
 * Kept identical in mobile/ and kiosk/.
 */

import {
  Backpack, Bath, BedDouble, Blocks, BookOpen, Car, Cat, CookingPot, Dog, Fish, Music, Pencil,
  Recycle, Shirt, ShoppingBasket, Smile, Sparkles, SprayCan, Sprout, Trash2, Utensils, WashingMachine,
  type LucideIcon,
} from "lucide-react"

export type ChoreIcon = { key: string; label: string; Icon: LucideIcon }

export const CHORE_ICONS: ChoreIcon[] = [
  { key: "dishes", label: "Dishes", Icon: Utensils },
  { key: "cooking", label: "Cooking", Icon: CookingPot },
  { key: "trash", label: "Trash", Icon: Trash2 },
  { key: "recycling", label: "Recycling", Icon: Recycle },
  { key: "bed", label: "Make bed", Icon: BedDouble },
  { key: "tidy", label: "Tidy up", Icon: Sparkles },
  { key: "toys", label: "Toys", Icon: Blocks },
  { key: "clean", label: "Clean", Icon: SprayCan },
  { key: "laundry", label: "Laundry", Icon: WashingMachine },
  { key: "clothes", label: "Clothes", Icon: Shirt },
  { key: "teeth", label: "Brush teeth", Icon: Smile },
  { key: "bath", label: "Bath", Icon: Bath },
  { key: "cat", label: "Cat", Icon: Cat },
  { key: "dog", label: "Dog", Icon: Dog },
  { key: "fish", label: "Fish", Icon: Fish },
  { key: "plants", label: "Plants", Icon: Sprout },
  { key: "homework", label: "Homework", Icon: Pencil },
  { key: "reading", label: "Reading", Icon: BookOpen },
  { key: "backpack", label: "Backpack", Icon: Backpack },
  { key: "music", label: "Practice", Icon: Music },
  { key: "shopping", label: "Shopping", Icon: ShoppingBasket },
  { key: "car", label: "Car", Icon: Car },
]

export function choreIcon(key: string | undefined): ChoreIcon | null {
  return CHORE_ICONS.find((i) => i.key === key) ?? null
}

// First match wins, so more specific words come first ("dishwasher" before "wash").
const SUGGESTIONS: [RegExp, string][] = [
  [/dish|plate|silverware/, "dishes"],
  [/cook|dinner|lunch|breakfast|bake/, "cooking"],
  [/recycl/, "recycling"],
  [/trash|garbage|bin\b|rubbish/, "trash"],
  [/\bbed\b|bedroom|sheets/, "bed"],
  [/toy|lego|blocks/, "toys"],
  [/laundry|washing/, "laundry"],
  [/clothes|fold|shirt|socks|dress/, "clothes"],
  [/teeth|tooth|floss/, "teeth"],
  [/\bbath\b|bathtime|shower/, "bath"],
  [/\bcat\b|kitty|litter|feed/, "cat"],
  [/\bdog\b|puppy|walk/, "dog"],
  [/fish|aquarium/, "fish"],
  [/plant|garden|water the|flowers/, "plants"],
  [/homework|math|spelling|worksheet/, "homework"],
  [/read|book/, "reading"],
  [/backpack|lunchbox|school bag|pack/, "backpack"],
  [/piano|guitar|violin|practice|music|sing/, "music"],
  [/groceries|grocery|shop|store/, "shopping"],
  [/\bcar\b/, "car"],
  [/tidy|pick up|\broom\b|declutter/, "tidy"],
  [/wipe|vacuum|sweep|mop|dust|counter|bathroom|clean/, "clean"],
]

/** A picture to suggest from a chore's name, e.g. "Feed Mochi" → cat. */
export function suggestChoreIcon(title: string): string | null {
  const t = title.toLowerCase()
  return SUGGESTIONS.find(([re]) => re.test(t))?.[1] ?? null
}
