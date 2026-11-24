package com.admin.common.dto;

import lombok.Data;

/**
 * <p>
 * Cloudflare 解析记录新增/修改 数据传输对象
 * </p>
 *
 * 注意 id / zoneId 都是 Cloudflare 的字符串主键(32 位 hex),不是数据库自增数字。
 *
 * @since 2026-11-25
 */
@Data
public class DnsRecordDto {

    /** 记录ID;为空 = 新增,有值 = 修改 */
    private String id;

    /** 面板里保存的 Cloudflare 账号ID */
    private Long accountId;

    /** 域名(zone)ID */
    private String zoneId;

    /** 记录类型 A / AAAA / CNAME / TXT / MX / NS ... */
    private String type;

    /** 记录名称(完整域名,如 hk.example.com;"@" 或留空表示 zone 本身) */
    private String name;

    /** 记录内容(IP / 目标域名 / 文本) */
    private String content;

    /** TTL 秒;1 = 自动 */
    private Integer ttl;

    /** 橙云代理开关 */
    private Boolean proxied;
}
