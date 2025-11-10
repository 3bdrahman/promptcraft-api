/**
 * Server-side Category Helpers
 *
 * Simple category utilities for API operations.
 * Minimal implementation focused on API needs.
 */

import { TEMPLATE_CATEGORIES } from '@promptcraft/shared/constants';

// Cache the category lookup map
let categoryLookup = null;

function buildCategoryLookup() {
  if (categoryLookup) return categoryLookup;

  categoryLookup = new Map();

  TEMPLATE_CATEGORIES.forEach(level1 => {
    level1.children.forEach(level2 => {
      level2.children.forEach(level3 => {
        categoryLookup.set(level3.id, {
          id: level3.id,
          label: level3.label,
          icon: level3.icon,
          parent: {
            id: level2.id,
            label: level2.label,
            icon: level2.icon,
            description: level2.description
          },
          grandparent: {
            id: level1.id,
            label: level1.label,
            icon: level1.icon,
            color: level1.color,
            description: level1.description
          }
        });
      });
    });
  });

  return categoryLookup;
}

/**
 * Get full category information from a Level 3 category ID
 */
export function getCategoryInfo(categoryId) {
  const lookup = buildCategoryLookup();
  return lookup.get(categoryId) || null;
}

/**
 * Get all Level 3 categories that belong to a specific grandparent
 */
export function getCategoriesByGrandparent(grandparentId) {
  const lookup = buildCategoryLookup();
  const categories = [];

  for (const [categoryId, info] of lookup) {
    if (info.grandparent.id === grandparentId) {
      categories.push(categoryId);
    }
  }

  return categories;
}

/**
 * Get all Level 3 categories that belong to a specific parent
 */
export function getCategoriesByParent(parentId) {
  const lookup = buildCategoryLookup();
  const categories = [];

  for (const [categoryId, info] of lookup) {
    if (info.parent.id === parentId) {
      categories.push(categoryId);
    }
  }

  return categories;
}

/**
 * Get filtered categories based on hierarchy filters
 */
export function getFilteredCategories({ grandparent, parent, category }) {
  if (category) {
    return [category];
  }

  if (parent) {
    return getCategoriesByParent(parent);
  }

  if (grandparent) {
    return getCategoriesByGrandparent(grandparent);
  }

  // Return all categories
  const lookup = buildCategoryLookup();
  return Array.from(lookup.keys());
}

/**
 * Check if a category ID is valid
 */
export function isValidCategory(categoryId) {
  if (!categoryId) return false;
  const lookup = buildCategoryLookup();
  return lookup.has(categoryId);
}