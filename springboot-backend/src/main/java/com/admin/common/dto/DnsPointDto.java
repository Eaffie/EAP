package com.admin.common.dto;

import lombok.Data;

/**
 * <p>
 * 「一键指向」数据传输对象:把某个域名指向一台转发机的 IP
 * </p>
 *
 * @since 2026-11-25
 */
@Data
public class DnsPointDto {

    /** 面板里保存的 Cloudflare 账号ID */
    private Long accountId;

    /** 要指向的域名(完整域名,如 hk.example.com) */
    private String name;

    /** 目标 IP(转发机当前 IP) */
    private String ip;
}
