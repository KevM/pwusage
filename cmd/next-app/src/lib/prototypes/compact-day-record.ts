import type { ArchiveCodec } from './compact-energy';
import type { LatestMetadata } from './compact-latest-metadata';
import type { DayAttribution, DayRecordStatus } from './day-attribution';

export interface EnergyDayRecord {
    site_id:string;day_start:Date;day_end:Date;revision:string;format_version:2;codec:ArchiveCodec;axis:'grid'|'offsets';checksum:string;payload:Buffer;
    expected_slots:number;sample_count:number;attribution_complete:boolean;first_timestamp:Date|null;last_timestamp:Date|null;max_interior_gap_ms:number|null;
    metadata_checksum:string|null;metadata_version:3;latest_metadata:LatestMetadata|null;latest_checksum:string|null;payload_checksum:string|null;
    /** Format 2 (metadata 3) only. */
    attribution:DayAttribution|null;status:DayRecordStatus|null;fetched_at:Date|null;
}
