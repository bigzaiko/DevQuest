// The map. Each track = one folder in src/content/<folder>/ with NN-slug.md lessons.
// To add a region (e.g. XAML / Avalonia / MAUI): create the folder, add an entry here, set `soon: false`.

export interface Track {
  id: string            // also the folder name
  prefix: string        // lesson id prefix, e.g. "fe" → fe-01
  title: string
  tagline: string
  icon: string          // emoji glyph used on the map
  color: string         // accent (hex)
  realm: string         // flavour name of the region on the map
  soon?: boolean        // shown as "coming soon", not clickable
}

export const TRACKS: Track[] = [
  { id: 'basecamp', prefix: 'bc', title: 'Basecamp', realm: 'The Camp', icon: '⛺', color: '#f5b83d',
    tagline: 'Tooling, terminal, Git, GitHub, publishing this site and your first weeks at a new job.' },
  { id: 'frontend', prefix: 'fe', title: 'Frontend', realm: 'React Reef', icon: '⚛️', color: '#22d4e8',
    tagline: 'Modern JS & TypeScript, React 19 + Vite, UI component forge, modular architecture, testing, real-time UI.' },
  { id: 'database', prefix: 'db', title: 'Database', realm: 'Postgres Peaks', icon: '🐘', color: '#6f9bff',
    tagline: 'SQL from SELECT to window functions, modeling, indexes, transactions, jsonb and job queues — on real PostgreSQL.' },
  { id: 'backend', prefix: 'be', title: 'Backend', realm: 'C# Citadel', icon: '🛡️', color: '#b57bff',
    tagline: 'C# 14 & .NET 10, ASP.NET Core APIs, EF Core, auth, testing, background jobs, SignalR, concurrency.' },
  { id: 'ops', prefix: 'ops', title: 'Containers & Kubernetes', realm: 'Container Harbor', icon: '🐳', color: '#3ddc97',
    tagline: 'Docker from zero, Dockerfiles, Compose, image security, registries — then Kubernetes up to production ops.' },
  { id: 'cloud', prefix: 'cl', title: 'Cloud-Native Toolkit', realm: 'The Armory', icon: '🧰', color: '#ff6b5a',
    tagline: 'Redis, caching, queues & brokers, S3 uploads, KEDA autoscaling, Keycloak identity and the observability stack.' },
  { id: 'pro', prefix: 'pro', title: 'Pro Skills', realm: 'Guild Hall', icon: '🧭', color: '#ff8fb1',
    tagline: 'CI/CD, secrets, security, debugging, teamwork, clean code, system design and interview prep.' },
  { id: 'capstone', prefix: 'cap', title: 'Capstone: BranchStory', realm: "The Dragon's Keep", icon: '🐉', color: '#ff5a2c',
    tagline: 'Build a production-shaped full-stack app end to end: React editor, ASP.NET API, Postgres, real-time, jobs, CI, K8s.' },
  { id: 'desktop', prefix: 'dsk', title: 'Desktop & Mobile .NET', realm: 'XAML Isles', icon: '🖥️', color: '#9aa4b2', soon: true,
    tagline: 'XAML, Avalonia UI and .NET MAUI — MVVM, data binding, styling, cross-platform apps.' },
]

/** Recommended route through the regions for a new full-stack job. */
export const ROUTE = ['basecamp', 'frontend', 'database', 'backend', 'ops', 'cloud', 'pro', 'capstone']
