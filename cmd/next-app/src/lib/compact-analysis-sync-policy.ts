/** Archive navigation reads what is stored; historic recovery requires explicit force. */
export function shouldSyncAnalysisHistory(options:{force:boolean;start:Date;end:Date;todayStart:Date;todayEnd:Date}):boolean {
    return options.force || (options.end>options.todayStart && options.start<options.todayEnd);
}
