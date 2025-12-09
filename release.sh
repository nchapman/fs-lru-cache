#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

error() { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }
info() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }

# Check argument
if [[ ! "$1" =~ ^(major|minor|patch)$ ]]; then
    echo "Usage: $0 <major|minor|patch>"
    exit 1
fi

BUMP_TYPE=$1

# Safety checks
info "Running safety checks..."

# Must be on develop branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "develop" ]; then
    error "Must be on develop branch. Currently on: $CURRENT_BRANCH"
fi

# Working directory must be clean
if [ -n "$(git status --porcelain)" ]; then
    error "Working directory is not clean. Commit or stash changes first."
fi

# Fetch latest from origin
info "Fetching latest from origin..."
git fetch origin

# Check develop is up to date with origin/develop
LOCAL_DEVELOP=$(git rev-parse develop)
REMOTE_DEVELOP=$(git rev-parse origin/develop)
if [ "$LOCAL_DEVELOP" != "$REMOTE_DEVELOP" ]; then
    error "Local develop ($LOCAL_DEVELOP) is not in sync with origin/develop ($REMOTE_DEVELOP). Run 'git pull' first."
fi

# Check main is up to date with origin/main
LOCAL_MAIN=$(git rev-parse main)
REMOTE_MAIN=$(git rev-parse origin/main)
if [ "$LOCAL_MAIN" != "$REMOTE_MAIN" ]; then
    error "Local main ($LOCAL_MAIN) is not in sync with origin/main ($REMOTE_MAIN). Run 'git fetch origin && git checkout main && git pull' first."
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
info "Current version: $CURRENT_VERSION"

# Parse version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Calculate new version
case $BUMP_TYPE in
    major)
        NEW_VERSION="$((MAJOR + 1)).0.0"
        ;;
    minor)
        NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
        ;;
    patch)
        NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
        ;;
esac

info "New version: $NEW_VERSION"

# Check if tag already exists
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
    error "Tag v$NEW_VERSION already exists!"
fi

# Confirm with user
warn "This will:"
echo "  1. Create release branch release/v$NEW_VERSION"
echo "  2. Bump version to $NEW_VERSION"
echo "  3. Merge to main and develop"
echo "  4. Create tag v$NEW_VERSION"
echo "  5. Push develop, main, and tags to origin"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    info "Aborted."
    exit 0
fi

# Start git flow release
info "Starting release v$NEW_VERSION..."
git flow release start "v$NEW_VERSION"

# Bump version in package.json
info "Bumping version in package.json..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Commit version bump
git add package.json
git commit -m "Bump version to $NEW_VERSION"

# Finish git flow release (this merges to main and develop, creates tag)
info "Finishing release..."
GIT_MERGE_AUTOEDIT=no git flow release finish -m "Release v$NEW_VERSION" "v$NEW_VERSION"

# Push everything
info "Pushing to origin..."
git push origin develop main --tags

info "Release v$NEW_VERSION complete!"
