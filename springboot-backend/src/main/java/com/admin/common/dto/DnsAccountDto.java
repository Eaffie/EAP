package com.admin.common.dto;

import lombok.Data;

/**
 * <p>
 * Cloudflare 账号新增/更新 数据传输对象
 * </p>
 *
 * token 只在保存时由前端明文提交一次,后端校验通过后立刻加密入库,不会再回传。
 *
 * @since 2026-11-25
 */
@Data
public class DnsAccountDto {

    /** 账号ID;为空 = 新增,有值 = 更新(此时 token 留空表示沿用原 token,只改备注名) */
    private Long id;

    /** 账号备注名 */
    private String name;

    /** Cloudflare API Token(明文,仅本次请求) */
    private String token;
}
