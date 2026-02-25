import { Button } from '@/components/ui/Button';
import { H1, H2, H3, P } from '@/components/ui/Typography';
import { DateNavigator, DateNavigatorButton, DateNavigatorContent, DateNavigatorLabel } from '@/components/ui/DateNavigator';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Label, Input, Select, Radio, Textarea, Checkbox } from '@/components/ui/Form';
import { Badge } from '@/components/ui/Badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/Table';
import { Spinner } from '@/components/ui/Spinner';
import { Skeleton } from '@/components/ui/Skeleton';
import { InteractiveExamples } from './InteractiveExamples';
import { StyleGuideToc } from './StyleGuideToc';
import { Breadcrumbs } from '@/components/Breadcrumbs';

export default function StyleGuidePage() {
    const tocItems = [
        { id: 'colors', label: 'Frosted Color Palette' },
        { id: 'typography', label: 'Typography' },
        { id: 'button-variants', label: 'Button Variants' },
        { id: 'button-sizes', label: 'Button Sizes' },
        { id: 'date-navigation', label: 'Date Navigation' },
        { id: 'cards', label: 'Card Containers' },
        { id: 'form-controls', label: 'Form Controls' },
        { id: 'badges', label: 'Badges' },
        { id: 'alerts', label: 'Alerts' },
        { id: 'empty-state', label: 'Empty State' },
        { id: 'breadcrumbs', label: 'Breadcrumbs' },
        { id: 'table-primitives', label: 'Table Primitives' },
        { id: 'loading-states', label: 'Loading States' },
        { id: 'interactive-components', label: 'Interactive Components' },
    ];

    return (
        <div id="top" className="max-w-5xl mx-auto p-8 pt-12 space-y-16">
            <div className="border-b border-gray-200 dark:border-slate-800 pb-5">
                <H1 className="mb-2">
                    Design System & Style Guide
                </H1>
                <P>
                    A living documentation of the core atomic components and theme configurations across the Pwusage app.
                </P>
            </div>

            <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8 lg:items-start">
                <aside className="hidden lg:block lg:sticky lg:top-20">
                    <StyleGuideToc items={tocItems} />
                </aside>
                <div className="space-y-16">
                    <div className="lg:hidden">
                        <StyleGuideToc items={tocItems} />
                    </div>

                    {/* Colors Section */}
                    <section id="colors" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Frosted Color Palette</H2>
                    <P className="mt-1">Semantic theme colors dynamically mapping between light and dark modes.</P>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="rounded-lg border border-gray-200 dark:border-slate-800 p-4 space-y-3">
                        <div className="h-16 w-full rounded-md bg-primary shadow-inner"></div>
                        <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">Primary</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">bg-primary / text-primary</p>
                        </div>
                    </div>
                    <div className="rounded-lg border border-gray-200 dark:border-slate-800 p-4 space-y-3">
                        <div className="h-16 w-full rounded-md bg-secondary shadow-inner border border-gray-200 dark:border-slate-700"></div>
                        <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">Secondary</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">bg-secondary / text-secondary</p>
                        </div>
                    </div>
                    <div className="rounded-lg border border-gray-200 dark:border-slate-800 p-4 space-y-3">
                        <div className="h-16 w-full rounded-md bg-bg-base shadow-inner border border-gray-200 dark:border-slate-700"></div>
                        <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">Background Base</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">bg-bg-base / text-bg-base</p>
                        </div>
                    </div>
                    <div className="rounded-lg border border-gray-200 dark:border-slate-800 p-4 space-y-3">
                        <div className="h-16 w-full rounded-md bg-bg-muted shadow-inner border border-gray-200 dark:border-slate-700"></div>
                        <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">Background Muted</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">bg-bg-muted</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Typography Section */}
            <section id="typography" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Typography</H2>
                    <P className="mt-1">Clean, sans-serif fonts using the semantic Frosted color scheme for varying hierarchies.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-8 rounded-lg border border-gray-200 dark:border-slate-800 space-y-8">
                    {/* H1 */}
                    <div>
                        <span className="text-xs text-secondary font-mono mb-2 block">Heading 1 / text-4xl / font-bold / text-primary</span>
                        <H1>
                            The quick brown fox jumps over the lazy dog
                        </H1>
                    </div>

                    {/* H2 */}
                    <div>
                        <span className="text-xs text-secondary font-mono mb-2 block">Heading 2 / text-2xl / font-semibold / text-gray-900</span>
                        <H2>
                            The quick brown fox jumps over the lazy dog
                        </H2>
                    </div>

                    {/* H3 */}
                    <div>
                        <span className="text-xs text-secondary font-mono mb-2 block">Heading 3 / text-lg / font-medium / text-gray-700</span>
                        <H3>
                            The quick brown fox jumps over the lazy dog
                        </H3>
                    </div>

                    {/* Body */}
                    <div>
                        <span className="text-xs text-secondary font-mono mb-2 block">Body / text-base / text-gray-600</span>
                        <P className="max-w-2xl leading-relaxed">
                            To make the &quot;Frosted Aura&quot; look truly cohesive, we pair it with a clean sans-serif font (like Inter or Roboto, standard in Next.js) and consistent padding. The ice blue works brilliantly as a background for data cards sitting on a white main background.
                        </P>
                    </div>
                </div>
            </section>

            {/* Buttons Section */}
            <section id="button-variants" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Button Variants</H2>
                    <P className="mt-1">Primary buttons are used for main actions, secondary/outline for alternatives. Glyph mode matches icon-only header actions, and icon mode supports icon+text.</P>
                </div>

                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800 overflow-x-auto">
                    <table className="min-w-full text-left">
                        <thead>
                            <tr className="border-b border-gray-200 dark:border-slate-800">
                                <th className="pb-3 pr-6 font-medium text-gray-500 dark:text-gray-400 text-sm">Variant</th>
                                <th className="pb-3 px-6 font-medium text-gray-500 dark:text-gray-400 text-sm">Default State</th>
                                <th className="pb-3 px-6 font-medium text-gray-500 dark:text-gray-400 text-sm">Hover/Focus (Simulated)</th>
                                <th className="pb-3 pl-6 font-medium text-gray-500 dark:text-gray-400 text-sm">Disabled State</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                            {/* Primary Row */}
                            <tr>
                                <td className="py-4 pr-6 text-sm font-medium text-gray-900 dark:text-white">Primary</td>
                                <td className="py-4 px-6">
                                    <Button variant="primary">Primary Action</Button>
                                </td>
                                <td className="py-4 px-6">
                                    <Button variant="primary" className="bg-primary/90 shadow-sm pointer-events-none">
                                        Hover State
                                    </Button>
                                </td>
                                <td className="py-4 pl-6">
                                    <Button variant="primary" disabled>Saving...</Button>
                                </td>
                            </tr>

                            {/* Secondary Row */}
                            <tr>
                                <td className="py-4 pr-6 text-sm font-medium text-gray-900 dark:text-white">Secondary</td>
                                <td className="py-4 px-6">
                                    <Button variant="secondary">Cancel</Button>
                                </td>
                                <td className="py-4 px-6">
                                    <Button variant="secondary" className="bg-secondary/80 text-gray-900 dark:text-gray-100 pointer-events-none">
                                        Hover State
                                    </Button>
                                </td>
                                <td className="py-4 pl-6">
                                    <Button variant="secondary" disabled>Unavailable</Button>
                                </td>
                            </tr>

                            {/* Outline Row */}
                            <tr>
                                <td className="py-4 pr-6 text-sm font-medium text-gray-900 dark:text-white">Outline</td>
                                <td className="py-4 px-6">
                                    <Button variant="outline">Sign Out</Button>
                                </td>
                                <td className="py-4 px-6">
                                    <Button variant="outline" className="bg-bg-muted text-gray-900 dark:text-gray-900 pointer-events-none">
                                        Hover State
                                    </Button>
                                </td>
                                <td className="py-4 pl-6">
                                    <Button variant="outline" disabled>Unavailable</Button>
                                </td>
                            </tr>

                            {/* Glyph Row */}
                            <tr>
                                <td className="py-4 pr-6 text-sm font-medium text-gray-900 dark:text-white">Glyph (Header)</td>
                                <td className="py-4 px-6">
                                    <Button appearance="glyph" aria-label="User profile">
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                                        </svg>
                                    </Button>
                                </td>
                                <td className="py-4 px-6">
                                    <Button appearance="glyph" className="text-blue-600 dark:text-blue-400 bg-gray-100 dark:bg-slate-800 pointer-events-none" aria-label="News">
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487a9 9 0 11-9.724 0M12 6v6m0 3h.008v.008H12V15z" />
                                        </svg>
                                    </Button>
                                </td>
                                <td className="py-4 pl-6">
                                    <Button appearance="glyph" disabled aria-label="Disabled icon">
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 11-12.728 0 9 9 0 0112.728 0z" />
                                        </svg>
                                    </Button>
                                </td>
                            </tr>

                            {/* Icon + Text Row */}
                            <tr>
                                <td className="py-4 pr-6 text-sm font-medium text-gray-900 dark:text-white">Icon + Text</td>
                                <td className="py-4 px-6">
                                    <Button
                                        appearance="icon"
                                        variant="primary"
                                        icon={
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                            </svg>
                                        }
                                    >
                                        Add Site
                                    </Button>
                                </td>
                                <td className="py-4 px-6">
                                    <Button
                                        appearance="icon"
                                        variant="outline"
                                        iconPosition="right"
                                        icon={
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                            </svg>
                                        }
                                        className="pointer-events-none"
                                    >
                                        Continue
                                    </Button>
                                </td>
                                <td className="py-4 pl-6">
                                    <Button
                                        appearance="icon"
                                        variant="secondary"
                                        disabled
                                        icon={
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12h15" />
                                            </svg>
                                        }
                                    >
                                        Disabled
                                    </Button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Button Sizes Section */}
            <section id="button-sizes" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Button Sizes</H2>
                    <P className="mt-1">Available density options for different UI requirements.</P>
                </div>
                <div className="flex items-end gap-6 bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <div className="flex flex-col items-center gap-2">
                        <Button size="sm">Small (sm)</Button>
                        <span className="text-xs text-gray-500 font-mono">h-8 px-3</span>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                        <Button size="md">Medium (md)</Button>
                        <span className="text-xs text-gray-500 font-mono">h-10 px-4</span>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                        <Button size="lg">Large (lg)</Button>
                        <span className="text-xs text-gray-500 font-mono">h-12 px-8</span>
                    </div>
                </div>
            </section>

            {/* Date Navigator Section */}
            <section id="date-navigation" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Date Navigation</H2>
                    <P className="mt-1">Standardized pill components for navigating through billing or usage periods.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-8 rounded-lg border border-gray-200 dark:border-slate-800 space-y-8 flex flex-col items-start min-w-full overflow-x-auto">

                    <div>
                        <span className="text-xs text-secondary font-mono mb-3 block">Standard Period (e.g., Monthly Bill)</span>
                        <DateNavigator>
                            <DateNavigatorButton direction="prev" />
                            <DateNavigatorContent>
                                <DateNavigatorLabel>
                                    Feb 11 - Mar 11, 2026
                                </DateNavigatorLabel>
                            </DateNavigatorContent>
                            <DateNavigatorButton direction="next" />
                        </DateNavigator>
                    </div>

                    <div>
                        <span className="text-xs text-secondary font-mono mb-3 block">Current Period (Next Disabled)</span>
                        <DateNavigator>
                            <DateNavigatorButton direction="prev" />
                            <DateNavigatorContent>
                                <DateNavigatorLabel>
                                    Mar 11 - Apr 11, 2026
                                </DateNavigatorLabel>
                            </DateNavigatorContent>
                            <DateNavigatorButton direction="next" disabled />
                        </DateNavigator>
                    </div>

                    <div>
                        <span className="text-xs text-secondary font-mono mb-3 block">Custom Range Mode</span>
                        <DateNavigator isCustom>
                            {/* Typically arrows are hidden in custom mode, leaving only the label */}
                            <DateNavigatorContent>
                                <DateNavigatorLabel isCustom>
                                    Mar 3 - Mar 15, 2026
                                </DateNavigatorLabel>
                            </DateNavigatorContent>
                        </DateNavigator>
                    </div>

                </div>
            </section>

            {/* Cards Section */}
            <section id="cards" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Card Containers</H2>
                    <P className="mt-1">Standardized surface containers for grouping related information, settings, or forms.</P>
                </div>
                <div className="p-8 rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-950">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 items-start">
                        <Card>
                            <CardHeader>
                                <CardTitle>Standard Card</CardTitle>
                                <CardDescription>
                                    A simple card with just a title and description in the header.
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <P>
                                    Card content goes here. The Card container automatically uses the theme background colors and provides a subtle drop shadow and border in light mode.
                                </P>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader
                                action={
                                    <Button variant="outline" size="sm">
                                        Options
                                    </Button>
                                }
                            >
                                <CardTitle>Card With Action</CardTitle>
                                <CardDescription>
                                    Cards supports an `action` prop on the header to mount controls to the right.
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <P>
                                    This is perfect for placing a dropdown, a date picker, or command buttons cleanly aligned with the title block without breaking flex layouts.
                                </P>
                            </CardContent>
                        </Card>

                        <Card density="compact">
                            <CardHeader density="compact">
                                <CardTitle density="compact">Compact Card</CardTitle>
                                <CardDescription>
                                    Use `density=&quot;compact&quot;` for small metadata or event cards in dense grids.
                                </CardDescription>
                            </CardHeader>
                            <CardContent density="compact">
                                <P className="text-sm">
                                    Compact cards use tighter radius and padding while retaining the same base surface tokens.
                                </P>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </section>

            {/* Form Controls Section */}
            <section id="form-controls" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Form Controls</H2>
                    <P className="mt-1">Standard input elements for forms and settings panels.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-8 rounded-lg border border-gray-200 dark:border-slate-800">
                    <div className="max-w-md space-y-6">
                        <div className="space-y-2">
                            <Label htmlFor="example-input">Text Input</Label>
                            <Input id="example-input" placeholder="Enter some text..." />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="example-select">Select Dropdown</Label>
                            <Select id="example-select">
                                <option value="1">Option 1</option>
                                <option value="2">Option 2</option>
                                <option value="3">Option 3</option>
                            </Select>
                        </div>

                        <div className="space-y-3">
                            <Label>Radio Buttons</Label>
                            <div className="flex gap-4">
                                <Label className="flex items-center gap-2 cursor-pointer font-normal">
                                    <Radio name="style-guide-radio" defaultChecked />
                                    <span>Option A</span>
                                </Label>
                                <Label className="flex items-center gap-2 cursor-pointer font-normal">
                                    <Radio name="style-guide-radio" />
                                    <span>Option B</span>
                                </Label>
                                <Label className="flex items-center gap-2 cursor-not-allowed opacity-50 font-normal">
                                    <Radio name="style-guide-radio-disabled" disabled />
                                    <span>Disabled</span>
                                </Label>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>Disabled Input State</Label>
                            <Input disabled placeholder="This field is disabled" />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="example-textarea">Textarea</Label>
                            <Textarea id="example-textarea" placeholder="Write a note..." />
                        </div>

                        <div className="space-y-2">
                            <Label className="flex items-center gap-2 font-normal">
                                <Checkbox defaultChecked />
                                <span>Enable notifications</span>
                            </Label>
                        </div>
                    </div>
                </div>
            </section>

            <section id="badges" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Badges</H2>
                    <P className="mt-1">Status and metadata tags for tables and dashboard cards.</P>
                </div>
                <div className="flex flex-wrap gap-3 bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <Badge>Default</Badge>
                    <Badge variant="success">Active</Badge>
                    <Badge variant="warning">Warning</Badge>
                    <Badge variant="danger">Error</Badge>
                    <Badge variant="info">Linked</Badge>
                </div>
            </section>

            <section id="alerts" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Alerts</H2>
                    <P className="mt-1">Inline feedback blocks for error, warning, success, and info states.</P>
                </div>
                <div className="space-y-4 bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <Alert variant="info">
                        <AlertTitle>Info</AlertTitle>
                        <AlertDescription>Waiting for Tesla refresh. Showing last synced data.</AlertDescription>
                    </Alert>
                    <Alert variant="success">
                        <AlertTitle>Success</AlertTitle>
                        <AlertDescription>Your configuration was saved successfully.</AlertDescription>
                    </Alert>
                    <Alert variant="warning">
                        <AlertTitle>Warning</AlertTitle>
                        <AlertDescription>Battery SoC may be stale based on last update time.</AlertDescription>
                    </Alert>
                    <Alert variant="danger">
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>Could not load data from Tesla API.</AlertDescription>
                    </Alert>
                </div>
            </section>

            <section id="empty-state" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Empty State</H2>
                    <P className="mt-1">Standard fallback for empty lists and unconfigured modules.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <EmptyState
                        title="No announcements yet"
                        description="Create a system announcement to notify all users."
                        action={<Button size="sm">Create Announcement</Button>}
                    />
                </div>
            </section>

            <section id="breadcrumbs" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Breadcrumbs</H2>
                    <P className="mt-1">Navigation trail for nested page context and quick backtracking.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <Breadcrumbs items={[
                        { label: 'Site Alpha', href: '/site/example' },
                        { label: 'Settings', href: '/site/example?view=settings' },
                        { label: 'Profile' }
                    ]} />
                </div>
            </section>

            <section id="table-primitives" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Table Primitives</H2>
                    <P className="mt-1">Reusable table structure for admin, tariff, and reporting views.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>User</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Last Sync</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            <TableRow>
                                <TableCell>alex@example.com</TableCell>
                                <TableCell><Badge variant="success">Active</Badge></TableCell>
                                <TableCell>Feb 20, 2026 2:15 PM</TableCell>
                            </TableRow>
                            <TableRow>
                                <TableCell>morgan@example.com</TableCell>
                                <TableCell><Badge variant="warning">Pending</Badge></TableCell>
                                <TableCell>Feb 20, 2026 1:03 PM</TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
            </section>

            <section id="loading-states" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Loading States</H2>
                    <P className="mt-1">Small spinner and skeleton surfaces for async loading placeholders.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800 space-y-6">
                    <div className="flex items-center gap-3">
                        <Spinner size="sm" />
                        <Spinner size="md" />
                        <Spinner size="lg" />
                    </div>
                    <div className="space-y-2 max-w-lg">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                    </div>
                </div>
            </section>

            <section id="interactive-components" className="space-y-6 scroll-mt-24">
                <div>
                    <H2>Interactive Components</H2>
                    <P className="mt-1">Tabs, switch, and toast examples with client-side interactions.</P>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-lg border border-gray-200 dark:border-slate-800">
                    <InteractiveExamples />
                </div>
                <div>
                    <a href="#top" className="text-sm text-primary hover:underline">Back to top</a>
                </div>
            </section>
                </div>
            </div>
        </div>
    );
}
